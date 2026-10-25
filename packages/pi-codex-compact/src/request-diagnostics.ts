import type { RemoteCompactionProtocol, RemoteCompactionProtocolSetting } from "./model-api.js";

type Stage = "binding" | "preparation" | "validation" | "boundary" | "preparedWait" | "authWait" | "rebind" | "preview";

/** Fixed, bounded metadata only. Never retain payloads, URLs, headers, IDs or error prose. */
export class RequestDiagnostics {
  phase: "binding" | "request" | "headers" | "stream" | "validation" = "binding";
  deadline = false;
  callerAbort = false;
  providerAbort = false;
  private readonly started = performance.now();
  private attemptStarted = this.started;
  private attempts = 0;
  private headersMs: number | undefined;
  private status: number | undefined;
  private mime: "sse" | "json" | "other" | "none" = "none";
  private bytes = 0;
  private chunks = 0;
  private lastByteAt: number | undefined;
  private body: "pending" | "open" | "eof" | "absent" | "pipe-error" | "aborted" = "pending";
  private events = 0;
  private terminals = [0, 0, 0, 0, 0];
  private firstByteAt: number | undefined;
  private firstEventAt: number | undefined;
  private firstCompactionAt: number | undefined;
  private terminalAt: number | undefined;
  private items = [0, 0, 0, 0];
  private readonly stages: Partial<Record<Stage, number>> = {};
  private kind: "compaction" | "recovery" = "compaction";
  private requested: RemoteCompactionProtocolSetting = "auto";
  private resolved: RemoteCompactionProtocol | "unresolved" = "unresolved";
  private append: "on" | "off" | "not-applicable" = "not-applicable";
  private frozen: string | undefined;
  private frozenCompact: string | undefined;

  configure(
    requested: RemoteCompactionProtocolSetting,
    resolved?: RemoteCompactionProtocol,
    append = true,
    kind: "compaction" | "recovery" = "compaction",
  ): void {
    this.kind = kind;
    this.requested = requested;
    this.resolved = resolved ?? "unresolved";
    this.append =
      kind === "compaction" && resolved === "context-management" ? (append ? "on" : "off") : "not-applicable";
  }

  record(stage: Stage, started: number): void {
    this.stages[stage] = (this.stages[stage] ?? 0) + performance.now() - started;
  }

  measure<T>(stage: Stage, action: () => T): T {
    const started = performance.now();
    try {
      return action();
    } finally {
      this.record(stage, started);
    }
  }

  async wait<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.record(stage, started);
    }
  }

  beginAttempt(): number {
    this.attempts += 1;
    this.attemptStarted = performance.now();
    this.phase = "request";
    this.headersMs = this.status = this.lastByteAt = undefined;
    this.firstByteAt = this.firstEventAt = this.firstCompactionAt = this.terminalAt = undefined;
    this.items.fill(0);
    this.mime = "none";
    this.bytes = this.chunks = this.events = 0;
    this.terminals.fill(0);
    this.body = "pending";
    this.providerAbort = false;
    return this.attempts;
  }

  get currentAttempt(): number {
    return this.attempts;
  }

  headers(response: Response, attempt: number): void {
    if (attempt !== this.attempts || this.frozen || this.headersMs !== undefined) return;
    this.phase = "headers";
    this.headersMs = performance.now() - this.attemptStarted;
    this.status = response.status;
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    this.mime = mime === "text/event-stream" ? "sse" : mime === "application/json" ? "json" : mime ? "other" : "none";
    this.body = response.body ? "open" : "absent";
  }

  chunk(bytes: number, attempt: number): void {
    if (attempt !== this.attempts || this.frozen) return;
    this.phase = "stream";
    this.bytes += bytes;
    this.chunks += 1;
    this.lastByteAt = performance.now();
    this.firstByteAt ??= this.lastByteAt;
  }

  end(attempt: number): void {
    if (attempt === this.attempts && !this.frozen) this.body = "eof";
  }

  pipeError(attempt: number, aborted: boolean): void {
    if (attempt === this.attempts && !this.frozen) this.body = aborted ? "aborted" : "pipe-error";
  }

  observe(event: unknown): void {
    if (this.frozen) return;
    this.events += 1;
    this.firstEventAt ??= performance.now();
    if (!event || typeof event !== "object" || !("type" in event)) return;
    const index = ["response.completed", "response.done", "response.incomplete", "response.failed", "error"].indexOf(
      typeof event.type === "string" ? event.type : "",
    );
    if (index >= 0) {
      this.terminals[index] += 1;
      this.terminalAt ??= performance.now();
    }
    if (event.type === "response.output_item.done" && "item" in event && event.item && typeof event.item === "object") {
      const type = "type" in event.item ? event.item.type : undefined;
      const category = type === "compaction" ? 0 : type === "reasoning" ? 1 : type === "message" ? 2 : 3;
      this.items[category] += 1;
      if (category === 0) this.firstCompactionAt ??= performance.now();
    }
  }

  providerAborted(attempt: number): void {
    if (attempt === this.attempts && !this.frozen) this.providerAbort = true;
  }

  seal(): void {
    this.frozenCompact ??= this.compact();
    this.frozen ??= this.summary();
  }

  /** Fits the generic prepared failure field's bounded display, without consumer coupling. */
  compact(): string {
    if (this.frozenCompact) return this.frozenCompact;
    const n = (value: number) => String(Math.min(9_999, Math.max(0, Math.floor(value))));
    return `diag phase=${this.phase} t=${n((performance.now() - this.started) / 1_000)}s n=${n(this.attempts)} http=${this.status ?? "-"} body=${this.body} term=${this.terminals.map(n).join("/")} abort=${Number(this.deadline)}/${Number(this.callerAbort)}/${Number(this.providerAbort)}`;
  }

  summary(): string {
    if (this.frozen) return this.frozen;
    const number = (value: number | undefined) =>
      value === undefined ? "-" : String(Math.min(999_999_999, Math.max(0, Math.floor(value))));
    const seconds = (value: number | undefined) => number(value === undefined ? undefined : value / 1_000);
    return (
      `diag phase=${this.phase} elapsed=${seconds(performance.now() - this.started)}s attempts=${number(this.attempts)} ` +
      `headers=${number(this.status)}@${seconds(this.headersMs)}s mime=${this.mime} ` +
      `body=${this.body} bytes=${number(this.bytes)} chunks=${number(this.chunks)} idle=${seconds(this.lastByteAt === undefined ? undefined : performance.now() - this.lastByteAt)}s ` +
      `events=${number(this.events)} terminal(c/d/i/f/e)=${this.terminals.map(number).join("/")} ` +
      `abort(d/c/p)=${Number(this.deadline)}/${Number(this.callerAbort)}/${Number(this.providerAbort)} ` +
      `kind=${this.kind} requested=${this.requested} resolved=${this.resolved} append=${this.append} ` +
      `milestones-ms(firstByte/firstEvent/firstCompaction/terminal/lastByte)=${[this.firstByteAt, this.firstEventAt, this.firstCompactionAt, this.terminalAt, this.lastByteAt].map((at) => number(at === undefined ? undefined : at - this.attemptStarted)).join("/")} ` +
      `items(compaction/reasoning/message/other)=${this.items.map(number).join("/")} ` +
      `stages-ms(binding/auth/preparation/validation)=${["binding", "authWait", "preparation", "validation"].map((stage) => number(this.stages[stage as Stage])).join("/")}`
    );
  }
}
