import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SCRATCHPAD_LIMITS = Object.freeze({
  itemBytes: 8 * 1024,
  fileBytes: 1024 * 1024,
  responseBytes: 64 * 1024,
  defaultPage: 20,
  maxPage: 100,
  previewCharacters: 200,
});
export type ScratchpadView = "full" | "summary" | "ids";
export type ScratchpadItem = {
  id: number;
  text: string;
  createdAt: string;
  updatedAt: string;
};
export interface ScratchpadDocument {
  schemaVersion: 1;
  sessionId: string;
  nextId: number;
  items: ScratchpadItem[];
}
export type ScratchpadRequest =
  | { action: "read"; ids?: number[]; view?: ScratchpadView; cursor?: string; limit?: number }
  | { action: "add"; texts: string[] }
  | { action: "update"; items: { id: number; text: string }[] }
  | { action: "delete"; ids: number[] };
export type ScratchpadReadItem =
  | ScratchpadItem
  | { id: number; preview: string; createdAt: string; updatedAt: string }
  | { id: number };
export type ScratchpadResult =
  | {
      success: true;
      action: "read";
      view: ScratchpadView;
      items: ScratchpadReadItem[];
      total: number;
      returnedCount: number;
      nextCursor: string | null;
    }
  | { success: true; action: "add" | "update" | "delete"; ids: number[]; count: number; message: string };
export class ScratchpadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScratchpadError";
  }
}
export interface ScratchpadExecutionOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}
const queues = new Map<string, Promise<unknown>>();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(code: string, message: string): never {
  throw new ScratchpadError(code, message);
}
function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= SCRATCHPAD_LIMITS.itemBytes
  );
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function validateIds(value: unknown): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > SCRATCHPAD_LIMITS.maxPage ||
    !value.every(positiveId) ||
    new Set(value).size !== value.length
  )
    fail("INVALID_INPUT", "Provide 1–100 distinct positive item IDs. No changes saved.");
}
function validateTexts(texts: unknown[]): void {
  for (const text of texts) {
    if (typeof text === "string" && Buffer.byteLength(text, "utf8") > SCRATCHPAD_LIMITS.itemBytes)
      fail("LIMIT_EXCEEDED", "An item exceeds the 8 KiB text limit. Split or shorten it. No changes saved.");
    if (!validText(text)) fail("INVALID_INPUT", "Item text must be a nonempty string. No changes saved.");
  }
}
function parseRequest(value: unknown): ScratchpadRequest {
  if (!record(value)) fail("INVALID_INPUT", "Provide a scratchpad action.");
  const fields: Record<string, string[]> = {
    read: ["action", "ids", "view", "cursor", "limit"],
    add: ["action", "texts"],
    update: ["action", "items"],
    delete: ["action", "ids"],
  };
  const allowed =
    typeof value.action === "string" && Object.hasOwn(fields, value.action) ? fields[value.action] : undefined;
  if (!allowed) fail("INVALID_INPUT", "Action must be read, add, update, or delete.");
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID_INPUT", "Input contains fields not supported by this action. No changes saved.");
  if (value.action === "read") {
    if (value.ids !== undefined) validateIds(value.ids);
    if (value.ids !== undefined && value.limit !== undefined)
      fail("INVALID_INPUT", "Limit applies to listing pages, not selected IDs.");
    if (value.ids !== undefined && value.cursor !== undefined) fail("INVALID_INPUT", "Use IDs or a cursor, not both.");
    if (value.view !== undefined && !["full", "summary", "ids"].includes(value.view as string))
      fail("INVALID_INPUT", "Read view must be full, summary, or ids.");
    if (value.limit !== undefined && (!positiveId(value.limit) || value.limit > SCRATCHPAD_LIMITS.maxPage))
      fail("INVALID_INPUT", "Read limit must be between 1 and 100.");
    if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 1024))
      fail("INVALID_INPUT", "Invalid read cursor.");
    return value as ScratchpadRequest;
  }
  if (value.action === "add") {
    if (!Array.isArray(value.texts) || !value.texts.length || value.texts.length > SCRATCHPAD_LIMITS.maxPage)
      fail("INVALID_INPUT", "Provide 1–100 item texts. No changes saved.");
    validateTexts(value.texts);
    return value as ScratchpadRequest;
  }
  if (value.action === "update") {
    if (!Array.isArray(value.items) || !value.items.every(record))
      fail("INVALID_INPUT", "Provide item ID/text pairs. No changes saved.");
    if (value.items.some((item) => Object.keys(item).some((key) => key !== "id" && key !== "text")))
      fail("INVALID_INPUT", "Update entries accept only id and text. No changes saved.");
    validateIds(value.items.map((item) => item.id));
    validateTexts(value.items.map((item) => item.text));
    return value as ScratchpadRequest;
  }
  if (value.action === "delete") {
    validateIds(value.ids);
    return value as ScratchpadRequest;
  }
  return fail("INVALID_INPUT", "Action must be read, add, update, or delete.");
}
function parseDocument(raw: string, sessionId: string): ScratchpadDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("INVALID_FILE", "Scratchpad JSON is invalid. The original file was preserved.");
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.sessionId !== sessionId ||
    !positiveId(value.nextId) ||
    !Array.isArray(value.items)
  )
    return fail(
      "INVALID_FILE",
      "Scratchpad metadata is invalid or belongs to another session. The original file was preserved.",
    );
  const ids = new Set<number>();
  for (const item of value.items) {
    if (
      !record(item) ||
      !positiveId(item.id) ||
      item.id >= value.nextId ||
      ids.has(item.id) ||
      !validText(item.text) ||
      !timestamp(item.createdAt) ||
      !timestamp(item.updatedAt) ||
      item.updatedAt < item.createdAt
    )
      return fail("INVALID_FILE", "Scratchpad items, IDs, or timestamps are invalid. The original file was preserved.");
    ids.add(item.id);
  }
  return value as unknown as ScratchpadDocument;
}
function checkCurrent(options: ScratchpadExecutionOptions): void {
  if (options.signal?.aborted) fail("CANCELLED", "Scratchpad operation cancelled. No changes saved.");
  if (options.isCurrent && !options.isCurrent())
    fail("SESSION_CHANGED", "The active session changed. No changes saved.");
}
function storageError(error: unknown, operation: "read" | "write"): ScratchpadError {
  if (error instanceof ScratchpadError) return error;
  const code = record(error) ? error.code : undefined;
  const reason =
    code === "EACCES" || code === "EPERM"
      ? "Permission denied."
      : code === "ENOSPC"
        ? "Disk is full."
        : "Storage operation failed.";
  return new ScratchpadError(
    operation === "read" ? "READ_FAILED" : "WRITE_FAILED",
    `${reason} ${operation === "write" ? "No changes saved." : "Scratchpad was not changed."}`,
  );
}

/** Local, session-scoped storage. Concurrent external writers are deliberately unsupported. */
export class ScratchpadStore {
  readonly directory: string;
  private readonly now: () => Date;
  constructor(options: { directory?: string; now?: () => Date } = {}) {
    this.directory = resolve(options.directory ?? join(getAgentDir(), "scratchpads"));
    this.now = options.now ?? (() => new Date());
  }
  async execute(
    sessionId: string,
    input: unknown,
    options: ScratchpadExecutionOptions = {},
  ): Promise<ScratchpadResult> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId))
      fail("INVALID_SESSION", "A valid session ID is required.");
    const request = parseRequest(input);
    const path = join(this.directory, `${sessionId}.json`);
    const previous = queues.get(path) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.run(path, sessionId, request, options));
    queues.set(path, pending);
    try {
      return await pending;
    } finally {
      if (queues.get(path) === pending) queues.delete(path);
    }
  }
  private async readRaw(path: string): Promise<string | undefined> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        fail("INVALID_FILE", "Scratchpad directory must be a regular directory, not a symbolic link.");
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink())
        fail("INVALID_FILE", "Scratchpad must be a regular file, not a symbolic link.");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const buffer = Buffer.alloc(SCRATCHPAD_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > SCRATCHPAD_LIMITS.fileBytes)
          fail(
            "LIMIT_EXCEEDED",
            "Scratchpad exceeds the 1 MiB file limit. Reduce it before using the tool; the file was preserved.",
          );
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        } catch {
          return fail("INVALID_FILE", "Scratchpad is not valid UTF-8. The original file was preserved.");
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return undefined;
      throw storageError(error, "read");
    }
  }
  private read(
    document: ScratchpadDocument,
    raw: string | undefined,
    request: Extract<ScratchpadRequest, { action: "read" }>,
  ): ScratchpadResult {
    const view = request.view ?? "full";
    const hash = digest(raw ?? "");
    let after = 0;
    if (request.cursor !== undefined) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch {
        fail("INVALID_INPUT", "Invalid read cursor.");
      }
      if (
        !record(cursor) ||
        cursor.v !== 1 ||
        cursor.sessionId !== document.sessionId ||
        cursor.view !== view ||
        !positiveId(cursor.lastId) ||
        typeof cursor.hash !== "string"
      )
        fail("INVALID_INPUT", "Invalid read cursor or view mismatch.");
      if (cursor.hash !== hash) fail("STALE_CURSOR", "Scratchpad changed. Restart the listing without a cursor.");
      after = cursor.lastId;
    }
    const all = [...document.items].sort((a, b) => a.id - b.id);
    if (request.ids) {
      const known = new Set(all.map((item) => item.id));
      const missing = request.ids.filter((id) => !known.has(id));
      if (missing.length)
        fail("ITEM_NOT_FOUND", `Items not found: ${missing.join(", ")}. Read current IDs before retrying.`);
    }
    const selected = request.ids ? new Set(request.ids) : undefined;
    const candidates = all.filter((item) => (selected ? selected.has(item.id) : item.id > after));
    const result: Extract<ScratchpadResult, { action: "read" }> = {
      success: true,
      action: "read",
      view,
      items: [],
      total: all.length,
      returnedCount: 0,
      nextCursor: null,
    };
    const limit = selected ? candidates.length : (request.limit ?? SCRATCHPAD_LIMITS.defaultPage);
    for (const item of candidates) {
      if (result.items.length >= limit) break;
      const output: ScratchpadReadItem =
        view === "ids"
          ? { id: item.id }
          : view === "summary"
            ? {
                id: item.id,
                preview: [...item.text].slice(0, SCRATCHPAD_LIMITS.previewCharacters).join(""),
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              }
            : { id: item.id, text: item.text, createdAt: item.createdAt, updatedAt: item.updatedAt };
      // Leave room for cursor and result metadata; every maximum-sized item fits by itself.
      if (bytes({ ...result, items: [...result.items, output] }) > SCRATCHPAD_LIMITS.responseBytes - 1024) break;
      result.items.push(output);
    }
    result.returnedCount = result.items.length;
    if (result.items.length < candidates.length) {
      if (selected) fail("LIMIT_EXCEEDED", "Selected items exceed the response limit. Read fewer IDs at a time.");
      const last = result.items.at(-1);
      if (!last) fail("LIMIT_EXCEEDED", "Item cannot fit in a read response.");
      result.nextCursor = Buffer.from(
        JSON.stringify({ v: 1, sessionId: document.sessionId, view, hash, lastId: last.id }),
      ).toString("base64url");
    }
    return result;
  }
  private async run(
    path: string,
    sessionId: string,
    request: ScratchpadRequest,
    options: ScratchpadExecutionOptions,
  ): Promise<ScratchpadResult> {
    checkCurrent(options);
    const raw = await this.readRaw(path);
    const document =
      raw === undefined
        ? { schemaVersion: 1 as const, sessionId, nextId: 1, items: [] }
        : parseDocument(raw, sessionId);
    checkCurrent(options);
    if (request.action === "read") return this.read(document, raw, request);
    const ids =
      request.action === "add" ? [] : request.action === "update" ? request.items.map((item) => item.id) : request.ids;
    const known = new Map(document.items.map((item) => [item.id, item]));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length)
      fail(
        "ITEM_NOT_FOUND",
        `Items not found: ${missing.join(", ")}. No changes saved. Read current IDs before retrying.`,
      );
    const now = this.now().toISOString();
    if (request.action === "add") {
      if (!Number.isSafeInteger(document.nextId + request.texts.length))
        fail("LIMIT_EXCEEDED", "Scratchpad item IDs are exhausted. No changes saved.");
      for (const text of request.texts) {
        const id = document.nextId++;
        ids.push(id);
        document.items.push({ id, text, createdAt: now, updatedAt: now });
      }
    } else if (request.action === "update") {
      for (const change of request.items) {
        const item = known.get(change.id);
        if (item && item.text !== change.text) {
          item.text = change.text;
          item.updatedAt = now < item.updatedAt ? item.updatedAt : now;
        }
      }
    } else {
      const removed = new Set(ids);
      document.items = document.items.filter((item) => !removed.has(item.id));
    }
    const output = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(output, "utf8") > SCRATCHPAD_LIMITS.fileBytes)
      fail(
        "LIMIT_EXCEEDED",
        "Scratchpad exceeds the 1 MiB file limit. Remove obsolete notes or shorten this batch. No changes saved.",
      );
    const temporary = join(this.directory, `.${sessionId}.${randomUUID()}.tmp`);
    try {
      checkCurrent(options);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Revalidate even for a new file, and detect external edits made during this call.
      const latest = await this.readRaw(path);
      if (latest !== raw)
        fail("FILE_CHANGED", "Scratchpad changed during this operation. No changes saved. Read it before retrying.");
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(output, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      checkCurrent(options);
      await rename(temporary, path);
    } catch (error) {
      throw storageError(error, "write");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return {
      success: true,
      action: request.action,
      ids,
      count: ids.length,
      message: `${request.action === "add" ? "Added" : request.action === "update" ? "Updated" : "Deleted"} items: ${ids.join(", ")}.`,
    };
  }
}
