import { diagnosticRuntime } from "./diagnostic-runtime.js";
import type { RemoteCompactionProtocol, RemoteCompactionProtocolSetting } from "./model-api.js";

type Stage = "binding" | "preparation" | "validation" | "boundary" | "preparedWait" | "authWait" | "rebind" | "preview";

/** Fixed, bounded metadata only. Never retain payloads, URLs, headers, or error prose. */
export class RequestDiagnostics {
  phase: "binding" | "request" | "headers" | "stream" | "validation" | "retry-wait" = "binding";
  deadline = false;
  callerAbort = false;
  providerAbort = false;
  private readonly started = performance.now();
  private readonly startedUtc = new Date().toISOString();
  private readonly runtime = diagnosticRuntime();
  private readonly previousAttempts: string[] = [];
  private omittedAttempts = 0;
  private lastEventAt: number | undefined;
  private timeoutMs: number | undefined;
  private openingRetries: number | undefined;
  private streamRetries = 0;
  private routeCategory = "unobserved";
  private reasoningEffort = "unobserved";
  private frozenReport: string | undefined;
  private finalResult = "";
  private finishedAttempt: string | undefined;
  private frozenStatus: string | undefined;
  private requestId: string | undefined;
  private sensitive: (() => readonly string[]) | undefined;

  requestPolicy(timeoutMs: number, openingRetries: number, sensitive?: () => readonly string[]): void {
    this.timeoutMs = timeoutMs;
    this.openingRetries = openingRetries;
    this.sensitive = sensitive;
  }

  endpoint(value: string): void {
    try {
      const url = new URL(value);
      this.routeCategory =
        url.protocol === "https:" && url.hostname === "api.openai.com"
          ? "openai-api"
          : url.protocol === "https:" && url.hostname === "chatgpt.com"
            ? "chatgpt-backend"
            : "custom";
    } catch {
      this.routeCategory = "unknown";
    }
  }

  get hadStreamRetry(): boolean {
    return this.streamRetries > 0;
  }

  payload(value: Record<string, unknown>): void {
    const reasoning = value.reasoning;
    const effort = reasoning && typeof reasoning === "object" && "effort" in reasoning ? reasoning.effort : undefined;
    this.reasoningEffort =
      effort === undefined
        ? "omitted"
        : typeof effort === "string" &&
            ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)
          ? effort
          : "other";
  }

  retryScheduled(): void {
    if (this.frozen) return;
    this.finishedAttempt = this.attemptReport();
    this.streamRetries += 1;
    this.phase = "retry-wait";
  }

  private attemptStarted = this.started;
  private attemptEndedAt: number | undefined;
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
  private kind: "compaction" | "recovery" | "text-summary" = "compaction";
  private requested: RemoteCompactionProtocolSetting = "auto";
  private resolved: RemoteCompactionProtocol | "unresolved" = "unresolved";
  private append: "on" | "off" | "not-applicable" = "not-applicable";
  private frozen: string | undefined;
  private frozenCompact: string | undefined;

  configure(
    requested: RemoteCompactionProtocolSetting,
    resolved?: RemoteCompactionProtocol,
    append = true,
    kind: "compaction" | "recovery" | "text-summary" = "compaction",
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
    if (this.attempts > 0) {
      const prior = this.finishedAttempt ?? this.attemptReport();
      if (this.previousAttempts.length < 12) this.previousAttempts.push(prior);
      else this.omittedAttempts += 1;
    }
    this.finishedAttempt = undefined;
    this.attempts += 1;
    this.attemptStarted = performance.now();
    this.attemptEndedAt = undefined;
    this.phase = "request";
    this.headersMs = this.status = this.lastByteAt = undefined;
    this.firstByteAt = this.firstEventAt = this.lastEventAt = this.firstCompactionAt = this.terminalAt = undefined;
    this.requestId = undefined;
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
    // Correlation IDs are the sole allowlisted header value. Reject nonstandard IDs
    // and any collision with known request material rather than echoing arbitrary data.
    const id = response.headers.get("x-request-id");
    const known = this.sensitive?.() ?? [];
    if (
      id &&
      /^req_[a-f0-9]{16,64}$/i.test(id) &&
      !known.some((value) => value && (value.includes(id) || id.includes(value)))
    )
      this.requestId = id;
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
    if (attempt === this.attempts && !this.frozen) {
      this.body = "eof";
      this.attemptEndedAt ??= performance.now();
    }
  }

  pipeError(attempt: number, aborted: boolean): void {
    if (attempt === this.attempts && !this.frozen) {
      this.body = aborted ? "aborted" : "pipe-error";
      this.attemptEndedAt ??= performance.now();
    }
  }

  observe(event: unknown): void {
    if (this.frozen) return;
    this.events += 1;
    this.lastEventAt = performance.now();
    this.firstEventAt ??= this.lastEventAt;
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
    this.frozenReport ??= this.report();
    this.frozenStatus ??= this.statusText();
    this.frozen ??= this.summary();
    this.sensitive = undefined;
  }

  private milliseconds(value: number | undefined): string {
    return value === undefined ? "-" : String(Math.min(999_999_999, Math.max(0, Math.floor(value))));
  }

  private attemptReport(): string {
    const now = this.attemptEndedAt ?? performance.now();
    const ms = (value: number | undefined) => this.milliseconds(value);
    return (
      `attempt=${this.attempts} offsetMs=${ms(this.attemptStarted - this.started)} durationMs=${ms(now - this.attemptStarted)} requestId=${this.requestId ?? "unavailable"}\n` +
      `${this.summary()} eventIdleMs=${ms(this.lastEventAt === undefined ? undefined : now - this.lastEventAt)} lastEventMs=${ms(this.lastEventAt === undefined ? undefined : this.lastEventAt - this.attemptStarted)}`
    );
  }

  finish(outcome: "failed" | "prepared" | "ready" | "recovered", safeFailure: string): void {
    // Callers pass only preparationFailureDetail's fixed categories, never provider prose.
    this.finalResult = `outcome=${outcome} failure=${safeFailure}`;
  }

  report(): string {
    if (this.frozenReport) return this.frozenReport + (this.finalResult ? `\n${this.finalResult}` : "");
    const termination = this.deadline
      ? "deadline"
      : this.callerAbort
        ? "caller"
        : this.providerAbort
          ? "provider-signal"
          : this.body === "eof"
            ? this.terminals.some((count) => count > 0)
              ? "terminal-event-observed"
              : "eof-without-terminal"
            : this.body;
    return [
      `Compaction diagnostics ${this.runtime} utc=${this.startedUtc}`,
      `route=${this.routeCategory} observedReasoningEffort=${this.reasoningEffort} timeoutMs=${this.milliseconds(this.timeoutMs)} openingRetries=${this.milliseconds(this.openingRetries)} eofRetriesScheduled=${this.streamRetries}/1 termination=${termination}`,
      ...this.previousAttempts,
      ...(this.omittedAttempts ? [`omittedAttempts=${this.omittedAttempts}`] : []),
      this.finishedAttempt ?? this.attemptReport(),
      "Timing is client-observed; EOF does not identify which upstream component closed the stream. Abort flags may overlap; caller does not necessarily mean user cancellation. No request or response content is logged.",
    ].join("\n");
  }

  private statusText(): string {
    const age = (at: number | undefined) =>
      at === undefined ? "none yet" : `${Math.floor((performance.now() - at) / 1000)}s ago`;
    return `${this.phase}; ${Math.floor((performance.now() - this.started) / 1000)}s elapsed; attempt ${this.attempts}; last byte ${age(this.lastByteAt)}; last event ${age(this.lastEventAt)}; ${this.kind === "text-summary" ? `summary messages ${this.items[2]}` : `compaction items ${this.items[0]}`}`;
  }

  snapshot(): { status: string; report: string; warning?: string } {
    const inactive = performance.now() - (this.lastByteAt ?? this.attemptStarted) >= 300_000;
    const noEvents = performance.now() - (this.lastEventAt ?? this.attemptStarted) >= 300_000;
    return {
      status: this.frozenStatus ?? this.statusText(),
      report: this.report(),
      ...(!this.frozen && (inactive || noEvents)
        ? {
            warning: `${inactive ? "No response bytes" : "No parsed response events"} for at least 5 minutes; still waiting, no timeout triggered. Silent compaction may still be working.`,
          }
        : {}),
    };
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
    const now = this.attemptEndedAt ?? performance.now();
    return (
      `diag phase=${this.phase} elapsed=${seconds(now - this.started)}s attempts=${number(this.attempts)} ` +
      `headers=${number(this.status)}@${seconds(this.headersMs)}s mime=${this.mime} ` +
      `body=${this.body} bytes=${number(this.bytes)} chunks=${number(this.chunks)} idle=${seconds(this.lastByteAt === undefined ? undefined : now - this.lastByteAt)}s ` +
      `events=${number(this.events)} terminal(c/d/i/f/e)=${this.terminals.map(number).join("/")} ` +
      `abort(d/c/p)=${Number(this.deadline)}/${Number(this.callerAbort)}/${Number(this.providerAbort)} ` +
      `kind=${this.kind} requested=${this.requested} resolved=${this.resolved} append=${this.append} ` +
      `milestones-ms(firstByte/firstEvent/firstCompaction/terminal/lastByte)=${[this.firstByteAt, this.firstEventAt, this.firstCompactionAt, this.terminalAt, this.lastByteAt].map((at) => number(at === undefined ? undefined : at - this.attemptStarted)).join("/")} ` +
      `items(compaction/reasoning/message/other)=${this.items.map(number).join("/")} ` +
      `stages-ms(binding/auth/preparation/validation)=${["binding", "authWait", "preparation", "validation"].map((stage) => number(this.stages[stage as Stage])).join("/")}`
    );
  }
}
