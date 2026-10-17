import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Collector } from "../src/collector.js";
import { identityIssue } from "../src/identity.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer } from "../src/server.js";
import { fixture } from "./fixtures.js";

function checkpoint(systemMessage: unknown) {
  const f = fixture();
  const compact = f.manager.getEntry(f.compact);
  if (!compact) throw Error("No checkpoint");
  Object.assign(compact, { systemMessage });
  f.manager.branch(f.compact);
  const leaf = f.manager.appendCustomEntry("descendant", {});
  return { ...f, checkpoint: compact, descendant: leaf };
}
function nativeEquality(f: ReturnType<typeof fixture>, id: string) {
  const native = buildSessionProjection(f.manager.getEntries(), id);
  const result = branch(f.manager, id, 0, []);
  expect(result.ancestryIssue).toBeUndefined();
  expect(result.projection.value).toEqual(
    JSON.parse(JSON.stringify(native.entries.map((entry) => ({ id: entry.sourceEntry.id, messages: entry.messages })))),
  );
  return { native, result };
}
describe("R42: every stored system-message projection source", () => {
  it.each([
    true,
    42,
    "bad",
    [],
    {},
    { role: "user", content: "bad" },
    { role: "system" },
    { role: "system", content: null },
    { role: "system", content: {} },
    { role: "system", content: [null] },
    { role: "system", content: "", sections: { bad: {} } },
    { role: "system", content: "", toolsAdded: [null] },
    { role: "system", content: "", toolsRemoved: {} },
  ])("diagnoses injected checkpoint envelope %j", (value) => {
    const f = checkpoint(value);
    const before = JSON.stringify(f.manager.getEntries());
    for (const id of [f.compact, f.descendant]) {
      expect(branch(f.manager, id, 0, []).ancestryIssue).toContain("checkpoint");
      expect(detail(f.manager, id, id, new Collector()).raw).toBeDefined();
    }
    expect(
      snapshot(f.manager, new Collector(), "g", 0, "", [], [], []).invalidEntries?.some((item) =>
        item.reason.includes("checkpoint"),
      ),
    ).toBe(true);
    expect(JSON.stringify(f.manager.getEntries())).toBe(before);
  });
  it.each([undefined, null, false, 0, ""])("preserves native ignored legacy checkpoint %j", (value) => {
    const f = checkpoint(value);
    nativeEquality(f, f.descendant);
    expect(identityIssue(f.checkpoint)).toBeUndefined();
  });
  it.each(["", [], [{ type: "text", text: "base" }]])(
    "preserves native checkpoint prompt/tool semantics with content %j",
    (content) => {
      const f = checkpoint({
        role: "system",
        content,
        sections: { removed: null, kept: "rule" },
        toolsAdded: [{ name: "checkpoint-tool", description: "tool", parameters: { type: "object" } }],
        toolsRemoved: [],
        timestamp: 1,
      });
      const { native, result } = nativeEquality(f, f.descendant);
      expect(result.prompt.value).toBe(getCurrentSystemPrompt(native.messages));
      expect(result.declaredTools.value).toEqual(JSON.parse(JSON.stringify(getCurrentTools(native.messages))));
    },
  );
  it("preserves newest-checkpoint-only replay with an older checkpoint in the retained range", () => {
    const f = fixture();
    f.manager.branch(f.compact);
    const second = f.manager.appendCompaction("second", f.compact, 900);
    const { native } = nativeEquality(f, second);
    expect(native.entries.filter((e) => e.sourceEntry.type === "compaction" && e.messages.length > 0)).toHaveLength(1);
  });
  it("serves authenticated raw checkpoint/descendant evidence rather than permanent 400", async () => {
    const f = checkpoint({ role: "system", content: { bad: true } });
    const c = new Collector();
    const server = await startServer({
      generation: "g",
      signal: new AbortController().signal,
      snapshot: () => snapshot(f.manager, c, "g", 0, "", [], [], []),
      branch: (id, offset) => branch(f.manager, id, offset, []),
      detail: (id, leaf) => detail(f.manager, id, leaf, c),
    });
    try {
      for (const id of [f.compact, f.descendant])
        for (const route of ["branch", "detail"]) {
          const response = await fetch(`${server.origin}/api/${route}?generation=g&id=${id}&leaf=${id}`, {
            headers: { "X-Inspector-Token": server.token },
          });
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.ancestryIssue).toContain("checkpoint");
          if (route === "detail") expect(body.raw).toBeDefined();
        }
    } finally {
      await server.close();
    }
  });
});
describe("R44: ordinary-message-only legacy content normalization", () => {
  for (const role of ["system", "user", "assistant", "toolResult"] as const) {
    it.each(["absent", "undefined", "null"])(`preserves native ${role} normalization for %s`, (variant) => {
      const f = fixture();
      const id =
        role === "system" ? f.system : role === "user" ? f.user : role === "assistant" ? f.assistant : f.result;
      const entry = f.manager.getEntry(id);
      if (entry?.type !== "message") throw Error("No message");
      if (variant === "absent") delete (entry.message as unknown as Record<string, unknown>).content;
      else Object.assign(entry.message, { content: variant === "null" ? null : undefined });
      const before = JSON.stringify(f.manager.getEntries());
      expect(identityIssue(entry)).toBeUndefined();
      nativeEquality(f, id);
      expect(snapshot(f.manager, new Collector(), "g", 0, "", [], [], []).nodes.some((n) => n.id === id)).toBe(true);
      expect(JSON.stringify(f.manager.getEntries())).toBe(before);
    });
  }
});
