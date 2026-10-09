import type { HistoryTextEdgeAnalyser } from "./application.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { encodedStringBytes, fitEncoded } from "./encoded-json.js";
import type { HistoryFact, StoredAt } from "./history-facts.js";
import type {
  HistoryContentItem,
  HistoryContentRead,
  HistoryContentRequest,
  HistoryItemsReference,
  HistoryTextReference,
  Problem,
  SessionFileChange,
  SessionHistoryValue,
} from "./projection-port.js";

const TEXT_SIZE = 4095;
const ITEM_SIZE = 8;
const ACTIVE_LIMIT = 32;
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
type Content = SessionHistoryValue;
const addressSchema = z.object({
  version: z.string(),
  scope: z.string(),
  field: z.enum([
    "content",
    "detail",
    "file-list",
    "output",
    "files",
    "path",
    "patch",
    "hunks",
    "lines",
    "line",
  ]),
  file: z.number().int().nonnegative().optional(),
  hunk: z.number().int().nonnegative().optional(),
  line: z.number().int().nonnegative().optional(),
});
type Address = z.infer<typeof addressSchema>;
const cursorSchema = z.object({
  readId: z.string(),
  reference: z.string(),
  offset: z.number().int().nonnegative(),
});
type Version = {
  readonly id: string;
  readonly runId: string;
  readonly previews: Map<string, Content>;
} & (
  | { readonly source: "stored"; readonly at: StoredAt }
  // Live previews and derived values without a stored coordinate.
  | { readonly source: "held"; readonly value: Content }
);
interface Read {
  readonly version: Version;
  readonly reference: string;
  readonly scope: string;
  readonly value: Content;
  readonly releaseSignal?: () => void;
}
const missing = (code = "history-content-stale"): HistoryContentRead => ({
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
  readStored(runId: string, at: StoredAt): Content | Problem;
  available(runId: string): true | Problem;
  readonly textEdges?: HistoryTextEdgeAnalyser;
}) {
  const key = randomBytes(32);
  const versions = new Map<string, Version>();
  const storedVersions = new Map<string, Version>();
  const values = new WeakMap<Content, Version>();
  const reads = new Map<string, Read>();
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
  function items(
    version: Version,
    field: Address["field"],
    extra: Partial<Address> = {},
  ): HistoryItemsReference {
    return {
      type: "history-items",
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
  function bounded(value: Content): Content | undefined {
    let cut = false;
    const take = (text: string, limit: Limit = PREVIEW) => {
      const shown = preview(text, limit);
      if (shown !== text) cut = true;
      return shown;
    };
    const optional = (text: string | undefined) =>
      text === undefined ? undefined : take(text);
    const files = (all: readonly SessionFileChange[]) => {
      if (all.length > 10 || all.some((file) => file.patch !== undefined))
        cut = true;
      return all
        .slice(0, 10)
        .map(({ patch: _patch, pathContent: _ref, ...file }) => ({
          ...file,
          path: take(file.path, PATH),
        }));
    };
    let shown: Content;
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
        previews: new Map<string, Content>(),
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
    value: Content,
    shown: Content,
    version: Version,
    scope: string,
    cached: Content | undefined,
  ): Content {
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
            filesReference:
              tool?.filesReference ?? items(version, "files", { scope }),
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
  function* detail(value: Content): Generator<string> {
    switch (value.kind) {
      case "message":
      case "thought":
      case "entry-prompt":
      case "steer":
        yield value.content;
        return;
      case "request":
      case "activity":
        yield value.description;
        return;
      case "agent-call":
        yield "Call\n";
        yield value.call;
        yield "\nReason\n";
        yield value.reason;
        if (value.refusal !== undefined) {
          yield "\nRefusal\n";
          yield value.refusal;
        }
        return;
      case "turn-result":
        yield "Result\n";
        yield value.result;
        if (value.harness !== undefined) {
          yield "\nHarness\n";
          yield value.harness;
        }
        if (value.model !== undefined) {
          yield "\nModel\n";
          yield value.model;
        }
        return;
    }
    if (value.kind === "turn-diff") {
      yield value.content;
      if (!value.files.some((file) => file.patch !== undefined)) return;
      yield "\n\nSupplied file patches";
    } else {
      yield "Input\n";
      yield value.input;
      if (value.cwd !== undefined) {
        yield "\nCwd\n";
        yield value.cwd;
      }
      if (value.count !== undefined) {
        yield `\nCount\n${value.count.value} `;
        yield value.count.unit;
      }
      if (
        value.outcome.kind === "failed" &&
        value.outcome.error !== undefined
      ) {
        yield "\nError\n";
        yield value.outcome.error;
      }
      if (
        value.outcome.kind === "declined" &&
        value.outcome.reason !== undefined
      ) {
        yield "\nRefusal\n";
        yield value.outcome.reason;
      }
      if (value.nativeOmission !== undefined) {
        yield "\nHarness omission\n";
        yield value.nativeOmission;
      }
    }
    for (const file of value.files ?? []) {
      yield "\n\n";
      yield file.path;
      if (file.kind !== undefined) yield `\n${file.kind}`;
      if (file.additions !== undefined) yield ` +${file.additions}`;
      if (file.removals !== undefined) yield ` -${file.removals}`;
      yield "\n";
      if (file.patch === undefined) yield "No patch supplied";
      else if (file.patch.kind === "unified") yield file.patch.content;
      else
        for (const hunk of file.patch.hunks) {
          yield `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
          for (const line of hunk.lines) {
            yield line;
            yield "\n";
          }
        }
    }
  }
  const filesOf = (value: Content) =>
    value.kind === "tool" || value.kind === "turn-diff"
      ? value.files
      : undefined;
  function* textParts(value: Content, address: Address): Generator<string> {
    const file = filesOf(value)?.[address.file ?? -1];
    const patch = file?.patch;
    const hunk =
      patch?.kind === "structured"
        ? patch.hunks[address.hunk ?? -1]
        : undefined;
    switch (address.field) {
      case "content":
        if (
          value.kind === "message" ||
          value.kind === "thought" ||
          value.kind === "entry-prompt" ||
          value.kind === "steer"
        ) {
          yield value.content;
          return;
        }
        break;
      case "detail":
        yield* detail(value);
        return;
      case "file-list":
        for (const file of filesOf(value) ?? []) {
          if (file.kind !== undefined) yield `${file.kind} `;
          yield file.path;
          if (file.additions !== undefined) yield ` +${file.additions}`;
          if (file.removals !== undefined) yield ` -${file.removals}`;
          yield "\n";
        }
        return;
      case "output":
        if (value.kind === "tool" && value.output) {
          yield value.output.text;
          return;
        }
        break;
      case "path":
        if (file) {
          yield file.path;
          return;
        }
        break;
      case "patch":
        if (patch?.kind === "unified") {
          yield patch.content;
          return;
        }
        break;
      case "line": {
        const line = hunk?.lines[address.line ?? -1];
        if (line !== undefined) {
          yield line;
          return;
        }
        break;
      }
    }
    throw new Error("Mismatched content target");
  }
  function itemPage(
    value: Content,
    version: Version,
    address: Address,
    offset: number,
  ): { items: HistoryContentItem[]; more: boolean } {
    const files = filesOf(value);
    const file = files?.[address.file ?? -1];
    const patch = file?.patch;
    const hunks = patch?.kind === "structured" ? patch.hunks : undefined;
    const hunk = hunks?.[address.hunk ?? -1];
    if (address.field === "files" && files !== undefined)
      return {
        items: files.slice(offset, offset + ITEM_SIZE).map((file, i) => ({
          kind: "file",
          path: text(version, "path", {
            scope: address.scope,
            file: offset + i,
          }),
          change: file.kind,
          additions: file.additions,
          removals: file.removals,
          patch:
            file.patch === undefined
              ? undefined
              : file.patch.kind === "unified"
                ? {
                    kind: "unified",
                    content: text(version, "patch", {
                      scope: address.scope,
                      file: offset + i,
                    }),
                  }
                : {
                    kind: "structured",
                    hunks: items(version, "hunks", {
                      scope: address.scope,
                      file: offset + i,
                    }),
                  },
        })),
        more: offset + ITEM_SIZE < files.length,
      };
    if (address.field === "hunks" && hunks)
      return {
        items: hunks.slice(offset, offset + ITEM_SIZE).map((hunk, i) => ({
          kind: "hunk",
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: items(version, "lines", {
            scope: address.scope,
            file: address.file,
            hunk: offset + i,
          }),
        })),
        more: offset + ITEM_SIZE < hunks.length,
      };
    if (address.field === "lines" && hunk)
      return {
        items: hunk.lines.slice(offset, offset + ITEM_SIZE).map((_, i) => ({
          kind: "line",
          content: text(version, "line", {
            scope: address.scope,
            file: address.file,
            hunk: address.hunk,
            line: offset + i,
          }),
        })),
        more: offset + ITEM_SIZE < hunk.lines.length,
      };
    throw new Error("Mismatched item target");
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
    closeRun(runId: string, deleted = false): void {
      for (const [id, read] of reads)
        if (read.version.runId === runId) release(id);
      for (const [id, version] of versions)
        if (version.runId === runId && (deleted || version.source === "held"))
          versions.delete(id);
      if (deleted)
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
        const address = addressSchema.parse(unseal(reference.id));
        const version = versions.get(address.version);
        if (!version || version.runId !== reference.runId) return missing();
        const available = deps.available(reference.runId);
        if (available !== true) return { found: false, problem: available };
        let offset = 0;
        let read: Read | undefined;
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
            releaseSignal: () =>
              request.signal?.removeEventListener("abort", abort),
          };
          reads.set(readId, read);
        }
        const cursor = (at: number) =>
          seal({ readId, reference: reference.id, offset: at });
        if (reference.type === "history-items") {
          const page = itemPage(read.value, version, address, offset);
          return {
            found: true,
            type: reference.type,
            items: page.items,
            readId: readId!,
            previous:
              offset > 0 ? cursor(Math.max(0, offset - ITEM_SIZE)) : undefined,
            next: page.more ? cursor(offset + ITEM_SIZE) : undefined,
          };
        }
        let total = 0;
        if (reference.type === "history-text")
          for (const part of textParts(read.value, address))
            total += part.length;
        // A fixed grid plus one boundary code unit keeps reverse reads exact,
        // including surrogate pairs, without a cursor stack or whole-body join.
        let skipped = 0,
          content = "",
          more = false;
        const startOffset = Math.max(0, offset - 1);
        const endOffset = offset + TEXT_SIZE + 1;
        for (const part of textParts(read.value, address)) {
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
        function* portions(): Generator<string> {
          for (const part of textParts(read!.value, address))
            for (let at = 0; at < part.length; at += TEXT_SIZE)
              yield part.slice(at, at + TEXT_SIZE);
        }
        const exact = content.slice(start, end);
        const edges = deps.textEdges?.(
          portions(),
          startOffset + start,
          startOffset + start + exact.length,
        );
        return {
          found: true,
          type: reference.type,
          content: exact,
          ...(edges ? { edges } : {}),
          readId: readId!,
          first: offset > 0 ? cursor(0) : undefined,
          last:
            offset <
            Math.max(0, Math.floor((total - 1) / TEXT_SIZE) * TEXT_SIZE)
              ? cursor(
                  Math.max(0, Math.floor((total - 1) / TEXT_SIZE) * TEXT_SIZE),
                )
              : undefined,
          previous:
            offset > 0 ? cursor(Math.max(0, offset - TEXT_SIZE)) : undefined,
          next: more ? cursor(offset + TEXT_SIZE) : undefined,
        };
      } catch (cause) {
        if (readId) release(readId);
        const invalid = missing("history-content-invalid");
        return invalid.found
          ? invalid
          : { found: false, problem: { ...invalid.problem, cause } };
      }
    },
  };
}
