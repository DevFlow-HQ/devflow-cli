import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { encodedStringBytes, fitEncoded } from "./encoded-json.js";
import type {
  HistoryFact,
  StoredAt,
  StoredFileChange,
  StoredHistoryValue,
} from "./history-facts.js";
import type {
  HistoryContentRead,
  HistoryContentRequest,
  HistoryTextEdgeResume,
  HistoryTextEdges,
  HistoryTextReference,
  Problem,
  SessionHistoryValue,
} from "./projection-port.js";

const TEXT_SIZE = 4095;
const ACTIVE_LIMIT = 32;
// A traversal keeps a checkpoint every eight pages, widening the spacing so it
// never keeps more than 128 (#520).
const CHECKPOINT_PAGES = 8;
const CHECKPOINT_LIMIT = 128;
// Private inline thresholds as [UTF-16 units, encoded bytes]. With references and
// headers, each projected row stays under 18 KiB, so a complete 200-row page plus
// one later preview per row stays inside the 8 MiB encoded allowance (#490).
type Limit = readonly [units: number, bytes: number];
const PREVIEW: Limit = [512, 1024];
const PATH: Limit = [128, 256];
const CONTENT: Limit = [TEXT_SIZE, 12 * 1024];
const fits = (text: string | undefined, [units, bytes]: Limit) =>
  text === undefined ||
  (text.length <= units && encodedStringBytes(text) <= bytes);
function preview(text: string, [units, bytes]: Limit = PREVIEW): string {
  return fitEncoded(text, units, bytes);
}
const addressSchema = z.object({
  version: z.string(),
  scope: z.string(),
  field: z.enum(["content", "detail", "file-list", "output", "path"]),
  file: z.number().int().nonnegative().optional(),
});
type Address = z.infer<typeof addressSchema>;
const count = z.number().int().nonnegative();
/** A part's place in a text body: `[group, sub, index]`. Group 0 holds the
 * bounded header parts; group 1+f is file f, whose sub 0 is its header and sub
 * 1+h is its hunk h. Each level skips to its index without visiting earlier parts. */
type PartAt = readonly [group: number, sub: number, index: number];
const START: PartAt = [0, 0, 0];
const cursorSchema = z.object({
  readId: z.string(),
  reference: z.string(),
  offset: count,
  total: count.optional(),
  // A sequential read resumes at the part holding `offset - 1`, which starts at
  // `skipped`, and resumes edge analysis from its state at `edgesAt`.
  from: z
    .object({
      at: z.tuple([count, count, count]),
      skipped: count,
      edges: z.record(z.string(), z.unknown()).optional(),
      edgesAt: count.optional(),
    })
    .optional(),
});
type Cursor = z.infer<typeof cursorSchema>;
interface Resume {
  readonly at: PartAt;
  readonly skipped: number;
  readonly edges?: HistoryTextEdgeResume;
  readonly edgesAt?: number;
}
/** A place in a text body: the part holding `position`, which starts at
 * `skipped`, and the edge analyser's state there. */
interface Point {
  readonly at: PartAt;
  readonly skipped: number;
  readonly position: number;
  readonly edges?: HistoryTextEdgeResume;
}
const ORIGIN: Point = { at: START, skipped: 0, position: 0 };
type Version = {
  readonly id: string;
  readonly runId: string;
  readonly previews: Map<string, SessionHistoryValue>;
} & (
  | { readonly source: "stored"; readonly at: StoredAt }
  // Live previews and derived values without a stored coordinate.
  | { readonly source: "held"; readonly value: StoredHistoryValue }
);
interface Read {
  readonly version: Version;
  readonly reference: string;
  readonly scope: string;
  readonly value: StoredHistoryValue;
  /** At most one seek point per spacing, keyed by its index; dropped with the
   * traversal and never stored. */
  readonly checkpoints: Map<number, Point>;
  readonly releaseSignal?: () => void;
}

/** Trusted presentation composition analyses bounded transient segments without
 * retaining them. Projection Port callers receive only content and edge counts.
 * `resume` is the analyser's own state at a previous portion's `end`; with it,
 * `source` begins at that position instead of the body's start, so a sequential
 * read never walks the body again (#514). */
export type HistoryTextEdgeAnalyser = (
  source: Iterable<string>,
  start: number,
  end: number,
  resume?: HistoryTextEdgeResume,
) => {
  readonly edges: HistoryTextEdges;
  /** State at `end`, for the portion that starts there. */
  readonly resume?: HistoryTextEdgeResume;
};

/** Observes each text read's walk: the body parts it visited and its traversal's
 * checkpoints afterwards; a test asserts seek cost through it (#520). */
export type HistoryContentWalkObserver = (walk: {
  readonly parts: number;
  readonly checkpoints: number;
}) => void;

const missing = (
  code = "history-content-stale",
): Extract<HistoryContentRead, { readonly found: false }> => ({
  found: false,
  problem: {
    code,
    explanation: "This exact history content is unavailable.",
    remediation: "Retry the current row's content.",
    possibleEffects: "none",
  },
});

/** References retain stored coordinates, never cached stored bodies. Live versions
 * survive only as current deliveries or bounded explicitly released traversals. */
export function createHistoryContent(deps: {
  readStored(runId: string, at: StoredAt): StoredHistoryValue | Problem;
  available(runId: string): true | Problem;
  readonly textEdges?: HistoryTextEdgeAnalyser;
  readonly walked?: HistoryContentWalkObserver;
}) {
  const key = randomBytes(32);
  const versions = new Map<string, Version>();
  const storedVersions = new Map<string, Version>();
  const values = new WeakMap<StoredHistoryValue, Version>();
  const reads = new Map<string, Read>();
  // Parts the current text read has visited, reported to `walked`.
  let partsVisited = 0;
  function seal(value: object): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }
  function unseal(token: string): unknown {
    const bytes = Buffer.from(token, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
  function text(
    version: Version,
    field: Address["field"],
    extra: Partial<Address> = {},
  ): HistoryTextReference {
    return {
      type: "history-text",
      runId: version.runId,
      id: seal({ version: version.id, field, ...extra }),
    };
  }
  function release(readId: string): void {
    const read = reads.get(readId);
    reads.delete(readId);
    read?.releaseSignal?.();
  }
  /** One pass decides and builds: every variable-length field is fitted here, so
   * a field cannot be shown unbounded or cut without its reference. Undefined
   * when nothing was cut, so a compact value stays the identical inline object. */
  function bounded(value: StoredHistoryValue): SessionHistoryValue | undefined {
    let cut = false;
    const take = (text: string, limit: Limit = PREVIEW) => {
      const shown = preview(text, limit);
      if (shown !== text) cut = true;
      return shown;
    };
    const optional = (text: string | undefined) =>
      text === undefined ? undefined : take(text);
    const files = (all: readonly StoredFileChange[]) => {
      if (all.length > 10 || all.some((file) => file.patch !== undefined))
        cut = true;
      return all.slice(0, 10).map(({ patch: _patch, ...file }) => ({
        ...file,
        path: take(file.path, PATH),
      }));
    };
    let shown: SessionHistoryValue;
    switch (value.kind) {
      case "message":
      case "thought":
      case "entry-prompt":
      case "steer":
        shown = { ...value, content: take(value.content, CONTENT) };
        break;
      case "agent-call":
        shown = {
          ...value,
          call: take(value.call),
          reason: take(value.reason),
          ...(value.refusal === undefined
            ? {}
            : { refusal: take(value.refusal) }),
        };
        break;
      case "request":
      case "activity":
        shown = { ...value, description: take(value.description) };
        break;
      case "turn-result":
        shown = {
          ...value,
          result: take(value.result),
          ...(value.harness === undefined
            ? {}
            : { harness: take(value.harness) }),
          ...(value.model === undefined ? {} : { model: take(value.model) }),
        };
        break;
      case "turn-diff":
        shown = {
          ...value,
          content: take(value.content),
          files: files(value.files),
        };
        break;
      case "tool":
        shown = {
          ...value,
          ...(value.files === undefined ? {} : { files: files(value.files) }),
          input: take(value.input),
          cwd: optional(value.cwd),
          nativeOmission: optional(value.nativeOmission),
          count:
            value.count === undefined
              ? undefined
              : { ...value.count, unit: take(value.count.unit) },
          outcome:
            value.outcome.kind === "failed"
              ? { ...value.outcome, error: optional(value.outcome.error) }
              : value.outcome.kind === "declined"
                ? { ...value.outcome, reason: optional(value.outcome.reason) }
                : value.outcome,
          output:
            value.output === undefined
              ? undefined
              : { ...value.output, text: take(value.output.text) },
        };
        break;
    }
    return cut ? shown : undefined;
  }
  function project(
    runId: string,
    fact: HistoryFact,
    scope: string,
  ): SessionHistoryValue {
    const value = fact.value;
    const shown = bounded(value);
    if (shown === undefined) return value;
    const known = values.get(value);
    // A live preview may keep its stored start's coordinate; it still reads live.
    const storedAt = fact.source === "stored" ? fact.stored : undefined;
    const storedKey =
      storedAt === undefined
        ? undefined
        : `${runId}:${JSON.stringify(storedAt)}`;
    let version =
      known ?? (storedKey ? storedVersions.get(storedKey) : undefined);
    if (version === undefined || !versions.has(version.id)) {
      const base = {
        id: randomUUID(),
        runId,
        previews: new Map<string, SessionHistoryValue>(),
      };
      if (storedAt !== undefined) {
        version = { ...base, source: "stored", at: storedAt };
        storedVersions.set(storedKey!, version);
      } else version = { ...base, source: "held", value };
      versions.set(version.id, version);
    }
    values.set(value, version);
    const cached = version.previews.get(scope);
    if (known && cached) return cached;
    const projected = withReferences(value, shown, version, scope, cached);
    if (cached && isDeepStrictEqual(cached, projected)) return cached;
    version.previews.set(scope, projected);
    return projected;
  }
  /** Reuses delivered references so an unchanged row keeps an identical value. */
  function withReferences(
    value: StoredHistoryValue,
    shown: SessionHistoryValue,
    version: Version,
    scope: string,
    cached: SessionHistoryValue | undefined,
  ): SessionHistoryValue {
    const detail =
      (cached && "detail" in cached ? cached.detail : undefined) ??
      text(version, "detail", { scope });
    switch (shown.kind) {
      case "message":
      case "thought":
      case "entry-prompt":
      case "steer":
        return {
          ...shown,
          reference:
            (cached && "reference" in cached ? cached.reference : undefined) ??
            text(version, "content", { scope }),
        };
      case "agent-call":
      case "request":
      case "activity":
      case "turn-result":
        return { ...shown, detail };
    }
    const tool =
      cached?.kind === "tool" || cached?.kind === "turn-diff"
        ? cached
        : undefined;
    const supplied =
      value.kind === "tool" || value.kind === "turn-diff"
        ? value.files
        : undefined;
    const fileFields =
      supplied === undefined || shown.files === undefined
        ? {}
        : {
            files: shown.files.map((file, index) =>
              fits(supplied[index]!.path, PATH)
                ? file
                : {
                    ...file,
                    pathContent:
                      tool?.files?.[index]?.pathContent ??
                      text(version, "path", { scope, file: index }),
                  },
            ),
            fileCount: supplied.length,
            filesDetail:
              tool?.filesDetail ?? text(version, "file-list", { scope }),
          };
    if (shown.kind === "turn-diff") return { ...shown, ...fileFields, detail };
    const output =
      value.kind === "tool" &&
      shown.output !== undefined &&
      !fits(value.output?.text, PREVIEW)
        ? {
            ...shown.output,
            reference:
              (tool?.kind === "tool" ? tool.output?.reference : undefined) ??
              text(version, "output", { scope }),
          }
        : shown.output;
    return { ...shown, ...fileFields, output, detail };
  }
  const filesOf = (value: StoredHistoryValue) =>
    value.kind === "tool" || value.kind === "turn-diff"
      ? value.files
      : undefined;
  /** The bounded count of parts before any file, each whole. */
  function headParts(
    value: StoredHistoryValue,
    address: Address,
  ): readonly string[] {
    const file = filesOf(value)?.[address.file ?? -1];
    switch (address.field) {
      case "content":
        if (
          value.kind === "message" ||
          value.kind === "thought" ||
          value.kind === "entry-prompt" ||
          value.kind === "steer"
        )
          return [value.content];
        break;
      case "detail":
        return detailHead(value);
      case "file-list":
        return [];
      case "output":
        if (value.kind === "tool" && value.output) return [value.output.text];
        break;
      case "path":
        if (file) return [file.path];
        break;
    }
    throw new Error("Mismatched content target");
  }
  function detailHead(value: StoredHistoryValue): readonly string[] {
    switch (value.kind) {
      case "message":
      case "thought":
      case "entry-prompt":
      case "steer":
        return [value.content];
      case "request":
      case "activity":
        return [value.description];
      case "agent-call":
        return [
          "Call\n",
          value.call,
          "\nReason\n",
          value.reason,
          ...(value.refusal === undefined
            ? []
            : ["\nRefusal\n", value.refusal]),
        ];
      case "turn-result":
        return [
          "Result\n",
          value.result,
          ...(value.harness === undefined
            ? []
            : ["\nHarness\n", value.harness]),
          ...(value.model === undefined ? [] : ["\nModel\n", value.model]),
        ];
      case "turn-diff":
        return value.files.some((file) => file.patch !== undefined)
          ? [value.content, "\n\nSupplied file patches"]
          : [value.content];
    }
    const outcome = value.outcome;
    return [
      "Input\n",
      value.input,
      ...(value.cwd === undefined ? [] : ["\nCwd\n", value.cwd]),
      ...(value.count === undefined
        ? []
        : [`\nCount\n${value.count.value} `, value.count.unit]),
      ...(outcome.kind === "failed" && outcome.error !== undefined
        ? ["\nError\n", outcome.error]
        : []),
      ...(outcome.kind === "declined" && outcome.reason !== undefined
        ? ["\nRefusal\n", outcome.reason]
        : []),
      ...(value.nativeOmission === undefined
        ? []
        : ["\nHarness omission\n", value.nativeOmission]),
    ];
  }
  function fileGroups(
    value: StoredHistoryValue,
    address: Address,
  ): readonly StoredFileChange[] {
    if (address.field === "file-list") return filesOf(value) ?? [];
    if (address.field !== "detail") return [];
    if (value.kind === "tool") return value.files ?? [];
    return value.kind === "turn-diff" &&
      value.files.some((file) => file.patch !== undefined)
      ? value.files
      : [];
  }
  function fileHead(
    file: StoredFileChange,
    field: Address["field"],
  ): readonly string[] {
    const counts = [
      ...(file.additions === undefined ? [] : [` +${file.additions}`]),
      ...(file.removals === undefined ? [] : [` -${file.removals}`]),
    ];
    if (field === "file-list")
      return [
        ...(file.kind === undefined ? [] : [`${file.kind} `]),
        file.path,
        ...counts,
        "\n",
      ];
    return [
      "\n\n",
      file.path,
      ...(file.kind === undefined ? [] : [`\n${file.kind}`]),
      ...counts,
      "\n",
      ...(file.patch === undefined
        ? ["No patch supplied"]
        : file.patch.kind === "unified"
          ? [file.patch.content]
          : []),
    ];
  }
  /** Text parts in order from `from`, each with its own place. */
  function* textParts(
    value: StoredHistoryValue,
    address: Address,
    [group, sub, index]: PartAt = START,
  ): Generator<readonly [string, PartAt]> {
    const head = headParts(value, address);
    for (let i = group === 0 ? index : head.length; i < head.length; i++) {
      partsVisited++;
      yield [head[i]!, [0, 0, i]];
    }
    const files = fileGroups(value, address);
    for (let f = Math.max(0, group - 1); f < files.length; f++) {
      const resumed = f === group - 1;
      const file = files[f]!;
      const header = fileHead(file, address.field);
      const first = !resumed ? 0 : sub === 0 ? index : header.length;
      for (let i = first; i < header.length; i++) {
        partsVisited++;
        yield [header[i]!, [1 + f, 0, i]];
      }
      const patch = file.patch;
      if (address.field !== "detail" || patch?.kind !== "structured") continue;
      for (
        let h = resumed ? Math.max(0, sub - 1) : 0;
        h < patch.hunks.length;
        h++
      ) {
        const hunk = patch.hunks[h]!;
        // A header, then each line and its newline.
        const parts = 1 + 2 * hunk.lines.length;
        for (let k = resumed && h === sub - 1 ? index : 0; k < parts; k++) {
          partsVisited++;
          yield [
            k === 0
              ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`
              : k % 2 === 1
                ? hunk.lines[(k - 1) / 2]!
                : "\n",
            [1 + f, 1 + h, k],
          ];
        }
      }
    }
  }
  return {
    project,
    prune(current: readonly SessionHistoryValue[]): void {
      const retained = new Set(current.map((value) => values.get(value)?.id));
      for (const read of reads.values()) retained.add(read.version.id);
      for (const [id, version] of versions)
        if (!retained.has(id)) {
          if (version.source === "held") versions.delete(id);
          else version.previews.clear();
        }
    },
    release,
    closeScope(scope: string): void {
      for (const [id, read] of reads) if (read.scope === scope) release(id);
      for (const version of versions.values()) version.previews.delete(scope);
    },
    /** Drops every read and version of a Run whose index is released or deleted. */
    closeRun(runId: string): void {
      for (const [id, read] of reads)
        if (read.version.runId === runId) release(id);
      for (const [id, version] of versions)
        if (version.runId === runId) versions.delete(id);
      for (const [id, version] of storedVersions)
        if (version.runId === runId) storedVersions.delete(id);
    },
    shutdown(): void {
      for (const id of reads.keys()) release(id);
      versions.clear();
      storedVersions.clear();
    },
    async read(request: HistoryContentRequest): Promise<HistoryContentRead> {
      if (request.signal?.aborted) return missing("history-read-released");
      let readId: string | undefined;
      try {
        const reference = request.reference;
        if (reference.type !== "history-text")
          return missing("history-content-invalid");
        const address = addressSchema.parse(unseal(reference.id));
        const version = versions.get(address.version);
        if (!version || version.runId !== reference.runId) return missing();
        const available = deps.available(reference.runId);
        if (available !== true) return { found: false, problem: available };
        let offset = 0;
        let read: Read | undefined;
        let resumed: Cursor | undefined;
        if (request.continuation !== undefined) {
          const cursor = cursorSchema.parse(unseal(request.continuation));
          readId = cursor.readId;
          read = reads.get(readId);
          if (
            !read ||
            read.reference !== reference.id ||
            cursor.reference !== reference.id ||
            read.version !== version
          )
            return missing("history-continuation-mismatch");
          offset = cursor.offset;
          resumed = cursor;
        } else {
          if (reads.size >= ACTIVE_LIMIT) return missing("history-read-limit");
          const value =
            version.source === "held"
              ? version.value
              : deps.readStored(version.runId, version.at);
          if (!value) return missing();
          if ("code" in value) return { found: false, problem: value };
          readId = randomUUID();
          const id = readId;
          const abort = () => release(id);
          request.signal?.addEventListener("abort", abort, { once: true });
          read = {
            version,
            reference: reference.id,
            scope: address.scope,
            value,
            checkpoints: new Map(),
            releaseSignal: () =>
              request.signal?.removeEventListener("abort", abort),
          };
          reads.set(readId, read);
        }
        const value = read.value;
        partsVisited = 0;
        // The exact version is immutable while pinned, so its total is walked once.
        let total = resumed?.total;
        if (total === undefined) {
          total = 0;
          for (const [part] of textParts(value, address)) total += part.length;
        }
        const cursor = (at: number, from?: Resume) =>
          seal({ readId, reference: reference.id, offset: at, total, from });
        // Transient bounded portions from `position` to `until`, beginning at a part known to precede it.
        function* portions(
          at: PartAt,
          partStart: number,
          position: number,
          until = Infinity,
        ): Generator<string> {
          for (const [part] of textParts(value, address, at)) {
            const first = Math.max(0, position - partStart);
            const last = Math.min(part.length, until - partStart);
            partStart += part.length;
            for (let cut = first; cut < last; cut += TEXT_SIZE)
              yield part.slice(cut, Math.min(last, cut + TEXT_SIZE));
            if (partStart >= until) return;
          }
        }
        // The analyser resumes only at its own state's position; without one it
        // analyses afresh from the body's start. A source cut at `until` still
        // captures the state there, but its edges are incomplete.
        const analyse = (
          point: Point,
          start: number,
          end: number,
          until?: number,
        ) => {
          const from =
            point.position === 0 || point.edges !== undefined ? point : ORIGIN;
          return deps.textEdges?.(
            portions(from.at, from.skipped, from.position, until),
            start,
            end,
            from.edges,
          );
        };
        const step = (point: Point, position: number): Point => {
          let skipped = point.skipped,
            at = point.at;
          for (const [part, place] of textParts(value, address, point.at)) {
            if (skipped + part.length > position) {
              at = place;
              break;
            }
            skipped += part.length;
          }
          // Only the state is kept, so the source stops at `position`: an attempt
          // left open there never scans on to the body's end.
          const edges = analyse(
            point,
            point.position,
            position,
            position,
          )?.resume;
          return { at, skipped, position, ...(edges && { edges }) };
        };
        const checkpoints = read.checkpoints;
        const interval =
          TEXT_SIZE *
          Math.max(
            CHECKPOINT_PAGES,
            Math.ceil(Math.ceil(total / TEXT_SIZE) / CHECKPOINT_LIMIT),
          );
        /** Keeps the first point a traversal reaches in each spacing after the first. */
        function keep(point: Point): void {
          const slot = Math.floor(point.position / interval);
          if (
            slot > 0 &&
            !checkpoints.has(slot) &&
            checkpoints.size < CHECKPOINT_LIMIT &&
            (deps.textEdges === undefined || point.edges !== undefined)
          )
            checkpoints.set(slot, point);
        }
        /** Walks from the nearest checkpoint at or before `position`, keeping one
         * at each spacing multiple it passes. */
        function seek(position: number, from?: Point): Point {
          let point = from;
          for (
            let slot = Math.floor(position / interval);
            point === undefined;
            slot--
          ) {
            const kept = slot > 0 ? checkpoints.get(slot) : ORIGIN;
            if (kept !== undefined && kept.position <= position) point = kept;
          }
          for (
            let mark = (Math.floor(point.position / interval) + 1) * interval;
            mark <= position;
            mark += interval
          )
            keep((point = step(point, mark)));
          return point.position < position ? step(point, position) : point;
        }
        // A fixed grid plus one boundary code unit keeps reverse reads exact,
        // including surrogate pairs, without a cursor stack or whole-body join.
        const startOffset = Math.max(0, offset - 1);
        const endOffset = offset + TEXT_SIZE + 1;
        const nextStart = offset + TEXT_SIZE - 1;
        // A sequential read resumes where the previous page ended; a seek resumes
        // from the nearest checkpoint.
        const from =
          resumed?.from !== undefined && resumed.from.skipped <= startOffset
            ? resumed.from
            : undefined;
        const sought = from ? undefined : seek(startOffset);
        const base = from ?? sought!;
        let skipped = base.skipped,
          content = "",
          more = false;
        let following: { at: PartAt; skipped: number } | undefined;
        for (const [part, at] of textParts(value, address, base.at)) {
          if (following === undefined && skipped + part.length > nextStart)
            following = { at, skipped };
          if (skipped + part.length <= startOffset) {
            skipped += part.length;
            continue;
          }
          content += part.slice(
            Math.max(0, startOffset - skipped),
            Math.max(0, endOffset - skipped),
          );
          skipped += part.length;
          if (skipped >= endOffset) {
            more = true;
            break;
          }
        }
        let start = offset === 0 ? 0 : 1;
        if (
          start === 1 &&
          /[\uD800-\uDBFF]/.test(content[0] ?? "") &&
          /[\uDC00-\uDFFF]/.test(content[1] ?? "")
        )
          start = 0;
        let end = (offset === 0 ? 0 : 1) + TEXT_SIZE;
        if (
          /[\uD800-\uDBFF]/.test(content[end - 1] ?? "") &&
          /[\uDC00-\uDFFF]/.test(content[end] ?? "")
        )
          end--;
        more ||= content.length > end;
        const exact = content.slice(start, end);
        const begin = startOffset + start;
        const finish = begin + exact.length;
        // A sequential read already holds the state at its start, so reading
        // forward keeps checkpoints too.
        const resumedAt: Point | undefined =
          from !== undefined &&
          (deps.textEdges === undefined ||
            (from.edges !== undefined && from.edgesAt === begin))
            ? {
                at: from.at,
                skipped: from.skipped,
                position: begin,
                ...(from.edges && { edges: from.edges }),
              }
            : undefined;
        if (resumedAt) keep(resumedAt);
        const analysed =
          deps.textEdges &&
          analyse(resumedAt ?? seek(begin, sought), begin, finish);
        deps.walked?.({ parts: partsVisited, checkpoints: checkpoints.size });
        const lastOffset = Math.max(
          0,
          Math.floor((total - 1) / TEXT_SIZE) * TEXT_SIZE,
        );
        return {
          found: true,
          type: reference.type,
          content: exact,
          ...(analysed ? { edges: analysed.edges } : {}),
          readId: readId!,
          first: offset > 0 ? cursor(0) : undefined,
          last: offset < lastOffset ? cursor(lastOffset) : undefined,
          previous:
            offset > 0 ? cursor(Math.max(0, offset - TEXT_SIZE)) : undefined,
          next: more
            ? cursor(
                offset + TEXT_SIZE,
                following && {
                  ...following,
                  ...(analysed?.resume === undefined
                    ? {}
                    : { edges: analysed.resume, edgesAt: finish }),
                },
              )
            : undefined,
        };
      } catch (cause) {
        if (readId) release(readId);
        const { problem } = missing("history-content-invalid");
        return { found: false, problem: { ...problem, cause } };
      }
    },
  };
}
