import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeSubagentDisplayText as sanitizeLabel } from "./display-text.js";
import type { ActiveJobDisplay, SubagentRuntime } from "./runtime.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings } from "./settings.js";

export const SUBAGENT_WIDGET_KEY = "subagents";
export const SUBAGENT_WIDGET_REFRESH_INTERVAL_MS = 1_000;

const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
const TASK_PREVIEW_WIDTH = 40;

export interface SubagentWidgetController {
  start(ctx: ExtensionContext, settings?: SubagentSettings): void;
  update(ctx: ExtensionContext, settings: SubagentSettings): void;
  shutdown(ctx: ExtensionContext): void;
}

export function createSubagentWidgetController(runtime: SubagentRuntime): SubagentWidgetController {
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeJobs: (() => void) | undefined;
  let publishedValue: string | undefined;
  let settings = { ...DEFAULT_SUBAGENT_SETTINGS };
  let clearWidget: (() => void) | undefined;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const stop = (): void => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    unsubscribeJobs?.();
    unsubscribeJobs = undefined;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ownsSession(ctx)) return;
    const jobs = settings.showWidget ? runtime.activeJobsForDisplay() : [];
    const value = `${JSON.stringify(settings)}\n${widgetValue(jobs)}`;
    if (value === publishedValue) return;
    if (jobs.length === 0) {
      ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
    } else {
      const snapshot = jobs.map(cloneDisplayJob);
      const preferences = { ...settings };
      ctx.ui.setWidget(
        SUBAGENT_WIDGET_KEY,
        (_tui, theme) => ({
          render: (width) => renderSubagentWidget(snapshot, theme, width, preferences),
          invalidate: () => {},
        }),
        WIDGET_OPTIONS,
      );
    }
    publishedValue = value;
  };

  return {
    start(ctx, preferences = DEFAULT_SUBAGENT_SETTINGS) {
      stop();
      clearWidget?.();
      clearWidget = undefined;
      settings = { ...preferences };
      activeSession = ctx.sessionManager;
      publishedValue = undefined;
      if (ctx.mode !== "tui") return;
      clearWidget = () => ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
      clearWidget();
      unsubscribeJobs = runtime.subscribeJobs(() => publish(ctx));
      refreshTimer = setInterval(() => publish(ctx), SUBAGENT_WIDGET_REFRESH_INTERVAL_MS);
      refreshTimer.unref();
      publish(ctx);
    },
    update(ctx, preferences) {
      if (!ownsSession(ctx)) return;
      settings = { ...preferences };
      publish(ctx);
    },
    shutdown(ctx) {
      if (!ownsSession(ctx)) return;
      stop();
      clearWidget?.();
      clearWidget = undefined;
      publishedValue = undefined;
      activeSession = undefined;
    },
  };
}

export function renderSubagentWidget(
  jobs: readonly ActiveJobDisplay[],
  theme: Theme,
  width: number,
  settings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS,
): string[] {
  if (!settings.showWidget) return [];
  const renderWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const lines = [
    theme.fg("borderMuted", "─".repeat(renderWidth)),
    theme.fg("muted", `Subagents · ${jobs.length} active`),
    ...jobs.map((job) => renderJob(job, theme, settings)),
  ];
  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

function renderJob(job: ActiveJobDisplay, theme: Theme, settings: SubagentSettings): string {
  const running = job.state === "running";
  const symbol = theme.fg(running ? "accent" : "dim", running ? "▶ " : "○ ");
  const state = theme.fg(running ? "accent" : "muted", job.state);
  const jobId = sanitizeLabel(job.jobId);
  const taskText = sanitizeLabel(job.task);
  // Pi's truncation adds ANSI resets; remove them before applying the callback theme.
  const task = stripTerminalSequences(truncateToWidth(taskText, TASK_PREVIEW_WIDTH, "…"));
  const labels = [
    ...(settings.showJobId ? [theme.fg("text", jobId)] : []),
    ...(visibleWidth(task) > 0 ? [theme.fg("text", task)] : []),
    state,
  ];
  const tools = job.tools.length > 0 ? job.tools.map(sanitizeLabel).join(", ") : "none";
  const timeout = job.timeout === undefined ? "no timeout" : formatSeconds(job.timeout);
  const details = [
    ...(settings.showTiming ? [`${formatSeconds(Math.floor(job.elapsedMs / 1_000))} / ${timeout}`] : []),
    ...(settings.showTools ? [`tools: ${tools}`] : []),
  ];
  const detail = details.length > 0 ? theme.fg("muted", ` · ${details.join(" · ")}`) : "";
  return `${symbol}${labels.join(" · ")}${detail}`;
}

function widgetValue(jobs: readonly ActiveJobDisplay[]): string {
  return jobs
    .map(
      (job) =>
        `${job.jobId}\0${job.task}\0${job.state}\0${Math.floor(job.elapsedMs / 1_000)}\0${job.timeout ?? ""}\0${job.tools.join(",")}`,
    )
    .join("\n");
}

function cloneDisplayJob(job: ActiveJobDisplay): ActiveJobDisplay {
  return { ...job, tools: [...job.tools] };
}

function formatSeconds(value: number): string {
  if (value < 60) return `${formatNumber(value)}s`;
  const wholeSeconds = Math.floor(value);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}
