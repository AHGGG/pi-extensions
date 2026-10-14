import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type KeybindingsConfig, Text, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { runCustomInteraction } from "../src/custom-interaction.js";
import { runDocumentReview } from "../src/document-review.js";
import { runThinkingSelector } from "../src/pi-selectors.js";
import { runTask } from "../src/task.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode} task loader updates theme, bounds resize and restores drafts after hard cancel`, async (t) => {
    let currentTheme = rendererTheme("dark");
    const theme = rendererTheme("dark");
    theme.fg = (role, text) => currentTheme.fg(role, text);
    const fixture = createRendererHost(mode, theme, { bindings: { "tui.select.cancel": "ctrl+q" } });
    t.onTestFinished(() => fixture.stop());
    let signal: AbortSignal | undefined;
    let settled = false;
    const running = runTask(fixture.ctx, {
      label: "Loading 你🙂",
      task: async (context) => {
        signal = context.signal;
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        settled = true;
      },
    });
    await fixture.waitForOpen();
    const before = fixture.frame().join("\n");
    assert.match(stripVTControlCharacters(before), /ctrl\+q\/ctrl\+c cancel/u);
    currentTheme = rendererTheme("light");
    fixture.host.invalidate();
    const after = fixture.frame().join("\n");
    assert.equal(stripVTControlCharacters(after), stripVTControlCharacters(before));
    assert.ok(after.includes(currentTheme.fg("dim", "ctrl+q/ctrl+c")));
    for (const width of [1, 2, 12, 35, 100]) {
      fixture.resize(width, 18);
      assert.ok(fixture.frame().every((line) => visibleWidth(line) <= width));
    }
    fixture.send("\x03");
    assert.deepEqual(await running, { kind: "cancelled" });
    assert.equal(signal?.aborted, true);
    assert.equal(settled, true);
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
    assert.equal(fixture.editor.getValue(), "main draft");
    fixture.send("\x1b[F");
    fixture.send("!");
    assert.equal(fixture.editor.getValue(), "main draft!");
  });

  test(`${mode} routes selector input through Pi and restores the main editor`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme());
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, {
      availableLevels: ["off", "low", "high"],
      currentLevel: "low",
      defaultLevel: "off",
    });
    await fixture.waitForOpen();
    const before = fixture.scroll.scrollTop;
    assert.match(fixture.frame().join("\n"), /ctrl\+s set as default/u);
    assert.ok(fixture.frame().join("\n").includes(CURSOR_MARKER));
    fixture.send("\x1b[B");
    assert.equal(fixture.scroll.scrollTop, before);
    fixture.send("\x13");
    assert.deepEqual(await running, { kind: "saveDefault", level: "high" });
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
    assert.equal(fixture.editor.getValue(), "main draft");
    fixture.send("\x1b[F");
    fixture.send("!");
    assert.equal(fixture.editor.getValue(), "main draft!");
  });

  test(`${mode} review keeps exact documents, active search and close under resize`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), {
      bindings: {
        "tui.select.cancel": "ctrl+q",
        "tui.altScreen.pageUp": "shift+pageUp",
        "tui.altScreen.pageDown": "shift+pageDown",
      },
    });
    t.onTestFinished(() => fixture.stop());
    const running = runDocumentReview(fixture.ctx, {
      title: "Exact review",
      content: Array.from({ length: 40 }, (_, index) => `  row-${index} 界 é  `).join("\n"),
      enableSearch: true,
      viewportSize: 4,
    });
    await fixture.waitForOpen();
    const first = stripVTControlCharacters(fixture.frame().join("\n"));
    assert.ok(first.includes("  row-0 界 é  "));
    fixture.send("\x1b[6~"); // Explicit host remap leaves plain PageDown available to the document.
    assert.doesNotMatch(stripVTControlCharacters(fixture.frame().join("\n")), /row-0 /u);
    fixture.send(" ");
    fixture.send("row-20");
    assert.match(stripVTControlCharacters(fixture.frame().join("\n")), /row-20/u);
    fixture.send("\x1b[H"); // Home belongs to the active search Input.
    fixture.send("\x1b[F");
    for (const width of [1, 2, 12, 35, 100]) {
      fixture.resize(width, 18);
      assert.ok(fixture.frame().every((line) => visibleWidth(line) <= width));
    }
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(fixture.frame(width), []);
    }
    fixture.resize(100, 30);
    fixture.send("\x03");
    assert.deepEqual(await running, { kind: "cancelled", reason: "close" });
    assert.equal(fixture.host.getFocusedComponent(), fixture.editor);
  });

  test(`${mode} forwards release events only to opted-in wrapped components`, async (t) => {
    const fixture = createRendererHost(mode, rendererTheme(), { kitty: true });
    t.onTestFinished(() => fixture.stop());
    const events: string[] = [];
    let releases = false;
    const running = runCustomInteraction(fixture.ctx, {
      create: ({ complete }) => ({
        get wantsKeyRelease() {
          return releases;
        },
        render: () => ["keys"],
        invalidate() {},
        handleInput(data) {
          events.push(data);
          if (data === "\x03") complete("closed");
        },
      }),
    });
    await fixture.waitForOpen();
    fixture.send("\x1b[97;1:3u");
    assert.deepEqual(events, []);
    releases = true;
    fixture.send("\x1b[97;1:1u");
    fixture.send("\x1b[97;1:2u");
    fixture.send("\x1b[97;1:3u");
    assert.deepEqual(events, ["\x1b[97;1:1u", "\x1b[97;1:2u", "\x1b[97;1:3u"]);
    fixture.send("\x03");
    assert.deepEqual(await running, { kind: "completed", value: "closed" });
  });
}

test("fullscreen reserves transcript page and search actions before replacement components", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme());
  t.onTestFinished(() => fixture.stop());
  const inputs: string[] = [];
  const running = runCustomInteraction(fixture.ctx, {
    create: ({ complete }) => ({
      render: () => ["custom screen"],
      invalidate() {},
      handleInput(data) {
        inputs.push(data);
        if (data === "\x03") complete("closed");
      },
    }),
  });
  await fixture.waitForOpen();
  const bottom = fixture.scroll.scrollTop;
  fixture.send("\x1b[5~");
  assert.ok(fixture.scroll.scrollTop < bottom);
  fixture.send("\x1b[1;5H");
  assert.equal(fixture.scroll.scrollTop, 0);
  fixture.send("\x1b[1;5F");
  assert.ok(fixture.scroll.scrollTop > 0);
  fixture.send("\x1b[H");
  fixture.send("\x1b[F");
  assert.deepEqual(inputs, ["\x1b[H", "\x1b[F"]);
  fixture.send("\x1b[102;6u");
  assert.equal(fixture.host.hasOverlay(), true);
  fixture.send("\x1b");
  assert.equal(fixture.host.hasOverlay(), false);
  fixture.send("\x03");
  await running;
});

test("fullscreen normalizes wheel modifiers and retains captured drag ownership", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme());
  t.onTestFinished(() => fixture.stop());
  const events: Array<{ type: string; x: number; delta?: number; alt: boolean }> = [];
  const running = runCustomInteraction(fixture.ctx, {
    create: ({ complete }) => ({
      render: () => ["pointer row"],
      invalidate() {},
      handleInput(data) {
        if (data === "\x03") complete("closed");
      },
      handleMouse(event) {
        events.push({ type: event.type, x: event.x, delta: event.wheelDelta, alt: event.alt });
        return event.type === "press" ? { capture: true, focus: true } : { handled: true };
      },
    }),
  });
  await fixture.waitForOpen();
  const y = 30; // One-based bottom dock row.
  fixture.send(`\x1b[<65;2;${y}M`);
  fixture.send(`\x1b[<73;2;${y}M`);
  fixture.send(`\x1b[<0;2;${y}M`);
  fixture.send("\x1b[<32;40;2M"); // Outside the dock, still owned by captured component.
  fixture.send("\x1b[<0;40;2m");
  assert.deepEqual(
    events.map((event) => event.type),
    ["wheel", "wheel", "press", "drag", "release"],
  );
  assert.equal(events[0].delta, 1);
  assert.equal(events[1].delta, 5);
  assert.equal(events[1].alt, true);
  assert.equal(events[3].x, 39);
  fixture.send("\x03");
  await running;
});

test("regular mode leaves mouse bytes to the terminal and does not normalize pointer events", async (t) => {
  const fixture = createRendererHost("regular", rendererTheme());
  t.onTestFinished(() => fixture.stop());
  let mouseCalls = 0;
  const inputs: string[] = [];
  const running = runCustomInteraction(fixture.ctx, {
    create: ({ complete }) => ({
      render: () => ["pointer row"],
      invalidate() {},
      handleMouse() {
        mouseCalls++;
        return { handled: true };
      },
      handleInput(data) {
        inputs.push(data);
        if (data === "\x03") complete("closed");
      },
    }),
  });
  await fixture.waitForOpen();
  fixture.send("\x1b[<65;2;30M");
  assert.equal(mouseCalls, 0);
  assert.deepEqual(inputs, ["\x1b[<65;2;30M"]);
  fixture.send("\x03");
  await running;
});

test("fullscreen focused overlays own viewport keys until focus is explicitly transferred", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme());
  t.onTestFinished(() => fixture.stop());
  const overlayInputs: string[] = [];
  const overlay = fixture.host.showOverlay(
    {
      render: () => ["unrelated overlay"],
      invalidate() {},
      handleInput: (data) => overlayInputs.push(data),
    },
    { width: 30 },
  );
  const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off", "high"], currentLevel: "off" });
  await fixture.waitForOpen();
  overlay.focus();
  fixture.send("\x1b[6~");
  assert.deepEqual(overlayInputs, ["\x1b[6~"]);
  overlay.setHidden(true);
  fixture.host.setFocus(fixture.component);
  fixture.send("\x1b[B");
  overlay.setHidden(false);
  overlay.unfocus({ target: fixture.component });
  fixture.send("\r");
  assert.deepEqual(await running, { kind: "selected", level: "high" });
  assert.equal(overlay.isHidden(), false);
  overlay.hide();
});

test("fullscreen follows unhandled wheel input and prioritizes OSC 8 links over enclosing click handlers", async (t) => {
  const fixture = createRendererHost("fullscreen", rendererTheme());
  t.onTestFinished(() => fixture.stop());
  let presses = 0;
  let clicks = 0;
  const link = new Text("\x1b]8;;https://example.com/\x07link\x1b]8;;\x07", 0, 0);
  const running = runCustomInteraction(fixture.ctx, {
    create: ({ complete }) => ({
      render: (width) => link.render(width),
      invalidate: () => link.invalidate(),
      handleMouse(event) {
        if (event.type === "press") presses++;
        if (event.type === "click") clicks++;
        return undefined;
      },
      handleInput(data) {
        if (data === "\x03") complete("closed");
      },
    }),
  });
  await fixture.waitForOpen();
  const before = fixture.scroll.scrollTop;
  fixture.send("\x1b[<64;2;30M");
  assert.ok(fixture.scroll.scrollTop < before);
  fixture.send("\x1b[<0;2;30M");
  fixture.send("\x1b[<0;2;30m");
  assert.deepEqual(fixture.urls, ["https://example.com/"]);
  assert.equal(presses, 1); // Unhandled press still reaches the enclosing component.
  assert.equal(clicks, 0); // Link activation suppresses the synthesized component click.
  fixture.send("\x03");
  await running;
});

test("callback theme replacement invalidates cached review output without changing payload or selection", async (t) => {
  let active = rendererTheme("dark");
  const theme = new Proxy({} as Theme, {
    get(_target, key) {
      const value = Reflect.get(active, key);
      return typeof value === "function" ? value.bind(active) : value;
    },
  });
  const fixture = createRendererHost("fullscreen", theme);
  t.onTestFinished(() => fixture.stop());
  const raw = "  const label = '界';  \n  second line  ";
  const running = runDocumentReview(fixture.ctx, {
    title: "Theme review",
    content: raw,
    format: { kind: "code", language: "typescript" },
    confirmation: { label: "Accept" },
  });
  await fixture.waitForOpen();
  const dark = fixture.frame().join("\n");
  active = rendererTheme("light");
  fixture.host.invalidate();
  const light = fixture.frame().join("\n");
  assert.notEqual(light, dark);
  assert.equal(stripVTControlCharacters(light), stripVTControlCharacters(dark));
  active = rendererTheme("light", true);
  fixture.host.invalidate();
  const terminalDefault = fixture.frame().join("\n");
  assert.equal(stripVTControlCharacters(terminalDefault), stripVTControlCharacters(light));
  assert.equal(terminalDefault.includes("\x1b[38;2;"), false);
  assert.equal(raw, "  const label = '界';  \n  second line  ");
  fixture.send("\r");
  assert.deepEqual(await running, { kind: "confirmed" });
});

// Each hinted save binding is also delivered through TuiBase's earlier listeners.
for (const scenario of [
  {
    name: "modifier order",
    kitty: true,
    save: ["shift+ctrl+x"],
    confirm: "ctrl+shift+x",
    data: "\x1b[120;6u",
    hint: "shift+ctrl+x",
  },
  { name: "matcher alias", kitty: false, save: ["return"], confirm: "enter", data: "\r", hint: "enter" },
  {
    name: "invalid and hard-cancel fallback",
    kitty: false,
    save: ["not-a-key", "ctrl+c", "ctrl+s"],
    confirm: "enter",
    data: "\x13",
    hint: "ctrl+s",
  },
  { name: "legacy Tab collision", kitty: false, save: ["ctrl+i"], confirm: "tab", data: "\t", hint: "ctrl+i" },
  {
    name: "extended Tab distinction",
    kitty: true,
    save: ["ctrl+i"],
    confirm: "tab",
    data: "\x1b[105;5u",
    hint: "ctrl+i",
  },
] as const) {
  test(`fullscreen hinted binding reaches selector: ${scenario.name}`, async (t) => {
    const bindings: KeybindingsConfig = {
      "app.thinking.save": [...scenario.save] as never,
      "tui.select.confirm": scenario.confirm as never,
    };
    const fixture = createRendererHost("fullscreen", rendererTheme(), { bindings, kitty: scenario.kitty });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    assert.ok(fixture.frame().join("\n").includes(`${scenario.hint} set as default`));
    fixture.send(scenario.data);
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}
