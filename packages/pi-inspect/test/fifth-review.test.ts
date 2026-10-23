import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { Collector } from "../src/collector.js";
import { correlatedCalls } from "../src/correlation.js";
import { SessionFeed } from "../src/feed.js";
import { identityIssue, recordedLeaf } from "../src/identity.js";
import { capture } from "../src/privacy.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { boundedSearch, searchNeedle } from "../src/web/search.js";
import { fixture } from "./fixtures.js";

function start(c: Collector, id: string, parent?: string) {
  c.start(
    { type: "tool_execution_start", toolCallId: id, toolName: "read", args: {}, parentToolCallId: parent },
    "anchor",
  );
}
function feed(f = fixture()) {
  const controller = new AbortController();
  const instance = new SessionFeed({
    pi: { getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI,
    context: () => ({ sessionManager: f.manager, getSystemPrompt: () => "" }) as unknown as ExtensionContext,
    collector: new Collector(),
    skills: [],
    generation: "g",
    signal: controller.signal,
    invalidate: () => {},
  });
  return { instance, controller, f };
}
describe("R23/R24: captured parent ambiguity and retained descendants", () => {
  it("does not assign ambiguous parents or backfill the relationship later", () => {
    const c = new Collector();
    start(c, "parent");
    start(c, "parent");
    start(c, "child", "parent");
    const child = c.list().at(-1);
    expect(child?.parentOccurrenceId).toBeUndefined();
    expect(child?.parentUnavailable).toContain("Overlapping");
    c.settle();
    start(c, "parent");
    expect(child?.parentOccurrenceId).toBeUndefined();
  });
  it("correlates children and grandchildren of an evicted parent by their authoritative assistant anchor", () => {
    const c = new Collector(3);
    start(c, "parent");
    start(c, "child", "parent");
    start(c, "grandchild", "child");
    start(c, "sibling", "parent");
    expect(c.list().some((call) => call.id === "parent")).toBe(false);
    expect(correlatedCalls(new Set(["parent"]), "anchor", c.list()).map((call) => call.id)).toEqual([
      "child",
      "grandchild",
      "sibling",
    ]);
    expect(correlatedCalls(new Set(["parent"]), "other", c.list())).toEqual([]);
  });
});
describe("R25/R26/R29/R31: malformed persisted evidence", () => {
  it.each([null, 1, {}, [], true])("diagnoses labels %j but retains healthy snapshot nodes", (value) => {
    const f = fixture();
    f.manager.appendLabelChange(f.user, value as string);
    const s = snapshot(f.manager, new Collector(), "g", 0, "", [], [], []);
    expect(s.nodes.some((node) => node.id === f.user)).toBe(true);
    expect(s.invalidEntries?.some((item) => item.reason.includes("label"))).toBe(true);
    expect(() => branch(f.manager, f.result, 0, [])).not.toThrow();
  });
  it("diagnoses non-string stored session names without aborting snapshot/reconciliation", () => {
    const x = feed();
    const id = x.f.manager.appendSessionInfo("valid");
    const entry = x.f.manager.getEntry(id);
    if (!entry) throw new Error("No title");
    Object.assign(entry, { name: { bad: true } });
    const view = x.instance.snapshot();
    expect(view.name).toContain("unavailable");
    expect(view.invalidEntries?.some((item) => item.reason.includes("session name"))).toBe(true);
    expect(() => x.instance.start()).not.toThrow();
    x.controller.abort();
  });
  it.each(["content", {}, 42, true])(
    "rejects non-array assistant content %j without breaking descendant raw details",
    (content) => {
      const f = fixture();
      const a = f.manager.getEntry(f.assistant);
      if (a?.type !== "message") throw new Error("No assistant");
      (a.message as unknown as Record<string, unknown>).content = content;
      expect(identityIssue(a)).toContain("envelope");
      const d = detail(f.manager, f.result, f.result, new Collector());
      expect(d.ancestryIssue).toContain("envelope");
      expect(JSON.stringify(d.raw)).toContain(f.result);
    },
  );
  it.each([undefined, null, "arguments", [], 12, true])("guards non-record tool arguments %j", (args) => {
    const f = fixture();
    const a = f.manager.getEntry(f.assistant);
    if (a?.type !== "message") throw new Error("No assistant");
    (a.message as unknown as Record<string, unknown>).content = [
      { type: "toolCall", id: "bad", name: "read", arguments: args },
    ];
    expect(branch(f.manager, f.assistant, 0, []).ancestryIssue).toContain("tool-call");
    expect(detail(f.manager, f.result, f.result, new Collector()).raw).toBeDefined();
  });
  it("guards malformed nested metadata without changing raw source", () => {
    const f = fixture();
    const r = f.manager.getEntry(f.result);
    if (r?.type !== "message") throw new Error("No result");
    (r.message as unknown as Record<string, unknown>).nestedCalls = { calls: [null, {}, "bad"] };
    const before = JSON.stringify(r);
    expect(() => branch(f.manager, f.result, 0, [])).not.toThrow();
    expect(JSON.stringify(r)).toBe(before);
  });
  it.each(["id", "parentId"])("rejects oversized %s without truncating identities", (key) => {
    const f = fixture();
    const entry = f.manager.getEntry(f.leaf);
    if (!entry) throw new Error("No leaf");
    f.manager.branch(f.leaf);
    (entry as unknown as Record<string, unknown>)[key] = "x".repeat(100000);
    expect(identityIssue(entry)).toContain("over-budget");
    expect(recordedLeaf(f.manager)).toBeNull();
    const s = snapshot(f.manager, new Collector(), "g", 0, "", [], [], []);
    expect(s.nodes.some((node) => node.id.length > 512)).toBe(false);
  });
});
describe("R27/R28/R30: bounded source and privacy/search", () => {
  it("reserves late leaf and real ancestry while keeping at most 10,000 nodes", () => {
    const f = fixture();
    const root = f.manager.getEntry(f.user);
    if (!root) throw new Error("No root");
    for (let i = 0; i < 10005; i++) {
      f.manager.branch(f.user);
      f.manager.appendCustomEntry("off", {});
    }
    f.manager.branch(f.user);
    const leaf = f.manager.appendCustomEntry("late leaf", {});
    const s = snapshot(f.manager, new Collector(), "g", 0, "", [], [], []);
    expect(s.leafId).toBe(leaf);
    expect(s.nodes.length).toBeLessThanOrEqual(10000);
    expect(s.nodes.find((node) => node.id === leaf)?.parentId).toBe(f.user);
    expect(s.nodes.some((node) => node.id === f.user)).toBe(true);
    expect(s.incomplete).toBe(true);
  });
  it.each(["x-api-key", "openai_api_key", "github_token", "service-access-token", "provider_private_key"])(
    "redacts %s after sanitation, not arbitrary metric/prose keys",
    (key) => {
      const source = { [key]: "private-value", tokenCount: 42, tokenize: "ordinary" };
      expect(JSON.stringify(capture(source))).not.toContain("private-value");
      expect(JSON.stringify(capture(source))).toContain("ordinary");
      expect(source[key]).toBe("private-value");
    },
  );
  it("sanitizes complete terminal sequences before the query cap and lowercases once", () => {
    expect(boundedSearch(`\x1b]${"hidden".repeat(10000)}\x07Visible`)).toBe("Visible");
    expect(boundedSearch("\x1b[31mVisible\x1b[0m")).toBe("Visible");
    expect(searchNeedle(`UPPER${"x".repeat(1000000)}`)).toHaveLength(512);
    expect(searchNeedle("UPPER")).toBe("upper");
  });
});
describe("R32/R35: polling and independent provider observations", () => {
  it("does no idle whole-history reads with the SDK's public count method, and supports readonly adapters", () => {
    vi.useFakeTimers();
    const x = feed();
    const reads = vi.spyOn(x.f.manager, "getEntries");
    x.instance.start();
    vi.advanceTimersByTime(5000);
    expect(reads).not.toHaveBeenCalled();
    x.controller.abort();
    vi.useRealTimers();
    const y = feed();
    const original = y.f.manager.getEntries.bind(y.f.manager);
    Object.defineProperty(y.f.manager, "getEntryCount", { value: undefined });
    const fallback = vi.spyOn(y.f.manager, "getEntries").mockImplementation(original);
    y.instance.start();
    expect(fallback).toHaveBeenCalledTimes(1);
    y.controller.abort();
  });
  it("never attaches replay/warming payloads to a previous context, and disposes both observations", () => {
    const x = feed();
    x.instance.observeContext([{ role: "user", content: "turn" }]);
    const context = x.instance.snapshot().context;
    x.instance.observePayload({ maxTokens: 100 });
    x.instance.observePayload({ maxTokens: 1 });
    const s = x.instance.snapshot();
    expect(s.context).toBe(context);
    expect(s.context).not.toHaveProperty("providerPayload");
    expect(s.providerObservation?.data.value).toMatchObject({ maxTokens: 1 });
    x.controller.abort();
    expect(() => x.instance.snapshot()).toThrow("stopped");
  });
});
