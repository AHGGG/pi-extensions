import { stripVTControlCharacters } from "node:util";

export interface StatuslineDisplay {
  template: string;
  window: string;
  countdown: string;
  separator: string;
}

export const DEFAULT_STATUSLINE_DISPLAY: Readonly<StatuslineDisplay> = Object.freeze({
  template: "{provider} {windows}",
  window: "{window}:{value}",
  countdown: "{value} ↻ {reset}",
  separator: " · ",
});

const PLACEHOLDERS = {
  template: ["provider", "windows"],
  window: ["window", "value"],
  countdown: ["window", "value", "reset"],
  separator: [],
} as const;

// Status text is one terminal line. Do not normalize spacing in user templates.
// biome-ignore lint/suspicious/noControlCharactersInRegex: These bytes must be rejected before terminal display.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function statuslineDisplayIssue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "statuslineDisplay must be an object";
  }
  for (const field of Object.keys(PLACEHOLDERS) as (keyof StatuslineDisplay)[]) {
    if (!Object.hasOwn(value, field)) continue;
    const text = (value as Record<string, unknown>)[field];
    const path = `statuslineDisplay.${field}`;
    if (typeof text !== "string") return `${path} must be a string`;
    if (CONTROLS.test(text)) return `${path} cannot contain terminal controls or line breaks`;
    if (field === "separator") continue;
    let invalidPlaceholder = false;
    const literal = text.replace(/\{([^{}]*)\}/gu, (_match, name: string) => {
      if (!(PLACEHOLDERS[field] as readonly string[]).includes(name)) invalidPlaceholder = true;
      return "";
    });
    if (/[{}]/u.test(literal)) return `${path} has malformed braces`;
    if (invalidPlaceholder) return `${path} has an unsupported placeholder`;
  }
  return undefined;
}

export function resolveStatuslineDisplay(value: Partial<StatuslineDisplay> = {}): StatuslineDisplay {
  const issue = statuslineDisplayIssue(value);
  if (issue) throw new Error(issue);
  return {
    template: value.template ?? DEFAULT_STATUSLINE_DISPLAY.template,
    window: value.window ?? DEFAULT_STATUSLINE_DISPLAY.window,
    countdown: value.countdown ?? DEFAULT_STATUSLINE_DISPLAY.countdown,
    separator: value.separator ?? DEFAULT_STATUSLINE_DISPLAY.separator,
  };
}

export function renderStatuslineTemplate(template: string, values: Record<string, string>): string {
  // One replacement pass: braces in replacement values are always literal text.
  return template.replace(/\{([^{}]*)\}/gu, (_match, name: string) => safeStatuslineText(values[name] ?? ""));
}

export function renderQuotaStatusline(provider: string, windows: string[], display: StatuslineDisplay): string {
  return renderStatuslineTemplate(display.template, {
    provider,
    windows: windows.filter(Boolean).join(display.separator),
  });
}

export function renderQuotaWindow(
  value: string,
  window: string,
  reset: string | undefined,
  display: StatuslineDisplay,
): string {
  return renderStatuslineTemplate(reset === undefined ? display.window : display.countdown, {
    value,
    window,
    reset: reset ?? "",
  });
}

export function safeStatuslineText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\t\n\r\u2028\u2029]/gu, " ")
    .replace(new RegExp(CONTROLS.source, "gu"), "");
}
