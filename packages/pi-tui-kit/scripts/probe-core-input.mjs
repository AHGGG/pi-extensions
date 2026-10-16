import assert from "node:assert/strict";
import { CURSOR_MARKER, Input, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Characterize the installed public Input API; do not patch prompt-aware pointer behavior.
const cases = [
  { name: "default", prompt: "> ", value: "abc", width: 20 },
  { name: "custom", prompt: "Search: ", value: "abc", width: 20 },
  { name: "preserved-UX", prompt: "Search: > ", value: "abc", width: 20 },
  { name: "default-scrolled", prompt: "> ", value: "abcdefghij", width: 8 },
  { name: "custom-scrolled", prompt: "Search: ", value: "abcdefghij", width: 14 },
  { name: "default-wide", prompt: "> ", value: "你🙂abc", width: 24 },
  { name: "custom-wide", prompt: "Search: ", value: "你🙂abc", width: 24 },
  { name: "wide-prompt", prompt: "你: ", value: "abc", width: 20 },
  { name: "narrow", prompt: "Search: ", value: "abc", width: 3 },
  { name: "zero", prompt: "Search: ", value: "abc", width: 0 },
];
const results = cases.map(({ name, prompt, value, width }) => {
  const input = new Input({ prompt, placeholder: "query" });
  input.setValue(value);
  input.handleInput("\u0005");
  const unfocused = input.render(width).join("\n");
  assert.equal(unfocused.includes(CURSOR_MARKER), false);
  input.focused = true;
  const focused = input.render(width).join("\n");
  assert.ok(visibleWidth(focused) <= width);
  if (width > visibleWidth(prompt)) assert.ok(focused.includes(CURSOR_MARKER));
  const visible = stripTerminalSequences(focused).slice(prompt.length).trimEnd();
  const expected = visible ? `${value.slice(0, value.indexOf(visible))}X${value.slice(value.indexOf(visible))}` : null;
  const result = input.handleMouse({
    type: "press",
    button: "left",
    x: visibleWidth(prompt),
    y: 0,
    width,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  });
  input.handleInput("X");
  const actual = input.getValue();
  if (name.startsWith("default")) assert.equal(actual, expected);
  return { name, width, focusedFrame: stripTerminalSequences(focused), expected, actual, pointerResult: result };
});
console.log(JSON.stringify(results, null, 2));
