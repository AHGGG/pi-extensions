import { isKeyRelease, parseKey } from "@earendil-works/pi-tui";

/** ProcessTerminal splits sequences; paste stays wrapped. Unknown replies are not activity. */
export function isUserActivity(data: string): boolean {
  if (!data || isKeyRelease(data)) return false;
  if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) return true;
  if (data === "\x1b[I") return true;
  if (data === "\x1b[O") return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Match the terminal's SGR protocol envelope.
  const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(data);
  if (sgr) return sgr[2] === "M" && (Number(sgr[1]) & 32) === 0;
  if (data.length === 6 && data.startsWith("\x1b[M")) {
    const button = data.charCodeAt(3) - 32;
    return (button & 32) === 0 && (button & 3) !== 3;
  }
  // Keys, modified keys, Escape and control keys use Pi's authoritative parser.
  if (parseKey(data) !== undefined) return true;
  // Plain Unicode/pasted characters without an escape/control envelope.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Capability reports are not user activity.
  return !/[\x00-\x1f\x7f-\x9f]/.test(data);
}
