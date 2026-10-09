import type { HistoryTextEdgeAnalyser } from "./application.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { HistoryFact } from "./history-facts.js";
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
const PREVIEW_SIZE = 512;
type ToolContent = Extract<SessionHistoryValue, { kind: "tool" | "turn-diff" }>;
const addressSchema = z.object({
  version: z.string(),
  scope: z.string(),
  field: z.enum([
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
  readonly previews: Map<string, ToolContent>;
} & (
  | { readonly source: "stored"; readonly eventIndex: number }
  | { readonly source: "preview"; readonly live: ToolContent }
);
interface Read {
  readonly version: Version;
  readonly reference: string;
  readonly scope: string;
  readonly value: ToolContent;
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
  readStored(runId: string, index: number): ToolContent | Problem;
  available(runId: string): true | Problem;
  readonly textEdges?: HistoryTextEdgeAnalyser;
}) {
  const key = randomBytes(32);
  const versions = new Map<string, Version>();
  const storedVersions = new Map<string, Version>();
  const values = new WeakMap<ToolContent, Version>();
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
  function preview(value: string, limit = PREVIEW_SIZE): string {
    return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
  }
  function filesPreview(
    files: readonly SessionFileChange[],
    version: Version,
    scope: string,
    cached?: readonly SessionFileChange[],
  ): readonly SessionFileChange[] {
    return files
      .slice(0, 10)
      .map(({ patch: _patch, pathContent: _ref, ...file }, index) => ({
        ...file,
        path: preview(file.path, 128),
        ...(file.path.length > 128
          ? {
              pathContent:
                cached?.[index]?.pathContent ??
                text(version, "path", { scope, file: index }),
            }
          : {}),
      }));
  }
  function project(
    runId: string,
    fact: HistoryFact,
    scope: string,
  ): SessionHistoryValue {
    const value = fact.value;
    if (value.kind !== "tool" && value.kind !== "turn-diff") return value;
    if (
      value.kind === "tool" &&
      value.input.length <= PREVIEW_SIZE &&
      (value.cwd?.length ?? 0) <= PREVIEW_SIZE &&
      (value.nativeOmission?.length ?? 0) <= PREVIEW_SIZE &&
      (value.count?.unit.length ?? 0) <= PREVIEW_SIZE &&
      (value.output?.text.length ?? 0) <= PREVIEW_SIZE &&
      (value.outcome.kind !== "failed" ||
        (value.outcome.error?.length ?? 0) <= PREVIEW_SIZE) &&
      (value.outcome.kind !== "declined" ||
        (value.outcome.reason?.length ?? 0) <= PREVIEW_SIZE) &&
      (value.files?.length ?? 0) <= 10 &&
      (value.files ?? []).every(
        (file) => file.path.length <= 128 && file.patch === undefined,
      )
    )
      return value;
    const known = values.get(value);
    const storedKey =
      fact.source === "stored" ? `${runId}:${fact.eventIndex}` : undefined;
    let version =
      known ?? (storedKey ? storedVersions.get(storedKey) : undefined);
    if (version === undefined || !versions.has(version.id)) {
      const base = {
        id: randomUUID(),
        runId,
        previews: new Map<string, ToolContent>(),
      };
      if (fact.source === "stored") {
        if (fact.eventIndex === undefined)
          throw new Error("Stored tool content must name its retained event");
        version = { ...base, source: "stored", eventIndex: fact.eventIndex };
        storedVersions.set(storedKey!, version);
      } else version = { ...base, source: "preview", live: value };
      versions.set(version.id, version);
    }
    values.set(value, version);
    const cached = version.previews.get(scope);
    if (known && cached) return cached;
    const detail = cached?.detail ?? text(version, "detail", { scope });
    const fileFields =
      value.files === undefined
        ? {}
        : {
            files: filesPreview(value.files, version, scope, cached?.files),
            fileCount: value.files.length,
            filesReference:
              cached?.filesReference ?? items(version, "files", { scope }),
            filesDetail:
              cached?.filesDetail ?? text(version, "file-list", { scope }),
          };
    let projected: ToolContent;
    if (value.kind === "turn-diff")
      projected = {
        ...value,
        content: preview(value.content),
        ...fileFields,
        detail,
      };
    else
      projected = {
        ...value,
        ...fileFields,
        input: preview(value.input),
        cwd: value.cwd === undefined ? undefined : preview(value.cwd),
        nativeOmission:
          value.nativeOmission === undefined
            ? undefined
            : preview(value.nativeOmission),
        count:
          value.count === undefined
            ? undefined
            : { ...value.count, unit: preview(value.count.unit) },
        outcome:
          value.outcome.kind === "failed"
            ? {
                ...value.outcome,
                error:
                  value.outcome.error === undefined
                    ? undefined
                    : preview(value.outcome.error),
              }
            : value.outcome.kind === "declined"
              ? {
                  ...value.outcome,
                  reason:
                    value.outcome.reason === undefined
                      ? undefined
                      : preview(value.outcome.reason),
                }
              : value.outcome,
        output:
          value.output === undefined
            ? undefined
            : {
                ...value.output,
                text: preview(value.output.text),
                ...(value.output.text.length > PREVIEW_SIZE
                  ? {
                      reference:
                        cached?.kind === "tool" && cached.output?.reference
                          ? cached.output.reference
                          : text(version, "output", { scope }),
                    }
                  : {}),
              },
        detail,
      };
    if (cached && isDeepStrictEqual(cached, projected)) return cached;
    version.previews.set(scope, projected);
    return projected;
  }
  function* detail(value: ToolContent): Generator<string> {
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
  function* textParts(value: ToolContent, address: Address): Generator<string> {
    const file = value.files?.[address.file ?? -1];
    const patch = file?.patch;
    const hunk =
      patch?.kind === "structured"
        ? patch.hunks[address.hunk ?? -1]
        : undefined;
    switch (address.field) {
      case "detail":
        yield* detail(value);
        return;
      case "file-list":
        for (const file of value.files ?? []) {
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
    value: ToolContent,
    version: Version,
    address: Address,
    offset: number,
  ): { items: HistoryContentItem[]; more: boolean } {
    const file = value.files?.[address.file ?? -1];
    const patch = file?.patch;
    const hunks = patch?.kind === "structured" ? patch.hunks : undefined;
    const hunk = hunks?.[address.hunk ?? -1];
    if (address.field === "files" && value.files !== undefined)
      return {
        items: value.files.slice(offset, offset + ITEM_SIZE).map((file, i) => ({
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
        more: offset + ITEM_SIZE < value.files.length,
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
      const retained = new Set(
        current.flatMap((value) =>
          value.kind === "tool" || value.kind === "turn-diff"
            ? [values.get(value)?.id]
            : [],
        ),
      );
      for (const read of reads.values()) retained.add(read.version.id);
      for (const [id, version] of versions)
        if (!retained.has(id)) {
          if (version.source === "preview") versions.delete(id);
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
        if (
          version.runId === runId &&
          (deleted || version.source === "preview")
        )
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
            version.source === "preview"
              ? version.live
              : deps.readStored(version.runId, version.eventIndex);
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
