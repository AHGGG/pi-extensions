import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Api, AuthResult, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  type CompactionBinding,
  compactionBindingChanges,
  resolveCompactionBinding,
  sameCompactionBinding,
} from "../src/compaction-binding.js";
import { type CodexCompactSettings, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";

type RequestAuth = Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;

function fixture() {
  const model: Model<Api> = {
    id: "fixture",
    name: "Fixture",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1000,
  };
  const state: {
    model: Model<Api>;
    auth: RequestAuth;
    providerAuth: AuthResult | undefined;
    provider: Provider;
    settings: CodexCompactSettings;
  } = {
    model,
    auth: { ok: true, apiKey: "fixture-secret-request-key" },
    providerAuth: { source: "OAuth", auth: { apiKey: "fixture-secret-request-key" } },
    provider: {
      id: model.provider,
      name: "Fixture",
      auth: {} as Provider["auth"],
      getModels: () => [model],
      stream() {
        throw new Error("unused");
      },
      streamSimple() {
        throw new Error("unused");
      },
    },
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
  };
  const calls = { requestAuth: 0, providerAuth: 0 };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        calls.requestAuth += 1;
        return state.auth;
      },
      getProviderAuth: async () => {
        calls.providerAuth += 1;
        return state.providerAuth;
      },
      getProvider: () => state.provider,
    },
  });
  return {
    state,
    calls,
    ctx: ctx as ExtensionContext,
    resolve: (isCurrent = () => true) =>
      resolveCompactionBinding(ctx as ExtensionContext, state.model, state.settings, isCurrent),
  };
}

function originalComparator(left: CompactionBinding | undefined, right: CompactionBinding): boolean {
  return (
    !!left &&
    left.key === right.key &&
    left.provider === right.provider &&
    left.stream === right.stream &&
    left.streamSimple === right.streamSimple
  );
}

describe("compaction binding diagnostics", () => {
  test("equivalent fresh model and authentication objects retain the original binding", async () => {
    const f = fixture();
    const first = await f.resolve();
    f.state.model = structuredClone(f.state.model);
    f.state.auth = structuredClone(f.state.auth);
    f.state.providerAuth = structuredClone(f.state.providerAuth);
    const second = await f.resolve();
    assert.notEqual(first.auth, second.auth);
    assert.notEqual(first.binding, second.binding);
    assert.equal(sameCompactionBinding(first.binding, second.binding), true);
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), []);
    assert.deepEqual(f.calls, { requestAuth: 2, providerAuth: 2 });
  });

  test("API key binding still hashes the exact model, route, request auth, and provider auth array", async () => {
    const f = fixture();
    f.state.providerAuth = { source: "API key", auth: { apiKey: "fixture-secret-request-key" } };
    const result = await f.resolve();
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          f.state.model,
          result.route,
          result.auth,
          f.state.providerAuth,
          [
            f.state.settings.appendMaintenanceMessage,
            f.state.settings.maintenanceMessage,
            f.state.settings.scratchpadEnabled,
          ],
        ]),
      )
      .digest("hex");
    assert.equal(result.binding.key, expected);
  });

  for (const protocol of ["auto", "context-management"] as const) {
    test(`verified OAuth rotation preserves the binding with ${protocol}`, async () => {
      const f = fixture();
      f.state.settings.protocol = protocol;
      const first = await f.resolve();
      for (const token of ["fixture-secret-rotated-key", "fixture-another-refresh"]) {
        f.state.auth = { ok: true, apiKey: token };
        f.state.providerAuth = { source: "OAuth", auth: { apiKey: token } };
        const next = await f.resolve();
        assert.equal(first.route.protocol, "context-management");
        assert.deepEqual(next.route, first.route);
        assert.equal(next.auth.apiKey, token);
        assert.equal(sameCompactionBinding(first.binding, next.binding), true);
        assert.deepEqual(compactionBindingChanges(first.binding, next.binding), []);
      }
    });
  }

  test("switching the ChatGPT account header with the same token reports only request authentication", async () => {
    const f = fixture();
    f.state.auth = {
      ok: true,
      apiKey: "fixture-secret-request-key",
      headers: { "ChatGPT-Account-Id": "fixture-account-before" },
    };
    const first = await f.resolve();
    f.state.auth = {
      ok: true,
      apiKey: "fixture-secret-request-key",
      headers: { "ChatGPT-Account-Id": "fixture-account-after" },
    };
    const second = await f.resolve();
    assert.equal(first.route.protocol, "context-management");
    assert.deepEqual(second.route, first.route);
    assert.equal(sameCompactionBinding(first.binding, second.binding), false);
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), ["request authentication changed"]);
  });

  for (const [name, auth] of [
    ["request token", { ok: true, apiKey: "fixture-secret-new-key" }],
    [
      "request headers",
      { ok: true, apiKey: "fixture-secret-request-key", headers: { "OpenAI-Project": "fixture-project" } },
    ],
    ["request endpoint", { ok: true, apiKey: "fixture-secret-request-key", baseUrl: "https://proxy.example/v1" }],
  ] satisfies [string, RequestAuth][]) {
    test(`${name} changes are attributed to request authentication`, async () => {
      const f = fixture();
      f.state.settings.protocol = "context-management";
      f.state.providerAuth = { source: "API key", auth: { apiKey: "fixture-secret-request-key" } };
      const first = await f.resolve();
      f.state.auth = auth;
      const second = await f.resolve();
      assert.deepEqual(second.route, first.route);
      assert.deepEqual(
        compactionBindingChanges(first.binding, second.binding),
        name === "request endpoint"
          ? ["request authentication changed", "provider authentication changed"]
          : ["request authentication changed"],
      );
      assert.equal(f.calls.requestAuth, 2);
      assert.equal(f.calls.providerAuth, name === "request endpoint" ? 1 : 2);
    });
  }

  for (const mutation of [
    "request env",
    "provider env",
    "provider metadata",
    "model endpoint",
    "model id",
    "request authorization",
    "model authorization",
    "provider id",
    "custom API",
    "missing provenance",
    "mismatched provenance",
  ] as const) {
    test(`OAuth refresh does not hide ${mutation}`, async () => {
      const f = fixture();
      f.state.settings.protocol = "context-management";
      const first = await f.resolve();
      f.state.auth = { ok: true, apiKey: "new-secret" };
      f.state.providerAuth = { source: "OAuth", auth: { apiKey: "new-secret" } };
      switch (mutation) {
        case "request env":
          Object.assign(f.state.auth, { env: { ROUTE: "changed" } });
          break;
        case "provider env":
          Object.assign(f.state.providerAuth, { env: { ROUTE: "changed" } });
          break;
        case "provider metadata":
          Object.assign(f.state.providerAuth.auth, { metadata: "changed" });
          break;
        case "model endpoint":
          f.state.model.baseUrl = "https://proxy.example/v1";
          break;
        case "model id":
          f.state.model.id = "other";
          break;
        case "request authorization":
          f.state.auth.headers = { Authorization: "Bearer override" };
          break;
        case "model authorization":
          f.state.model.headers = { Authorization: "Bearer override" };
          break;
        case "provider id":
          f.state.model.provider = "custom";
          break;
        case "custom API":
          f.state.model.api = "openai-codex-responses";
          break;
        case "missing provenance":
          f.state.providerAuth = undefined;
          break;
        case "mismatched provenance":
          f.state.providerAuth.auth.apiKey = "different-secret";
          break;
      }
      const next = await f.resolve();
      assert.equal(sameCompactionBinding(first.binding, next.binding), false);
      assert.ok(compactionBindingChanges(first.binding, next.binding).length);
      assert.doesNotMatch(
        JSON.stringify(compactionBindingChanges(first.binding, next.binding)),
        /secret|Bearer|override/,
      );
    });
  }

  for (const kind of ["API key", "custom provider", "proxy", "authorization override"] as const) {
    test(`${kind} retains exact token guards`, async () => {
      const f = fixture();
      f.state.settings.protocol = "context-management";
      if (kind === "API key")
        f.state.providerAuth = { source: "API key", auth: { apiKey: "fixture-secret-request-key" } };
      if (kind === "custom provider") f.state.model.provider = "custom";
      if (kind === "proxy") f.state.model.baseUrl = "https://proxy.example/v1";
      if (kind === "authorization override") f.state.model.headers = { Authorization: "Bearer override" };
      const first = await f.resolve();
      f.state.auth = { ok: true, apiKey: "new-secret" };
      assert.ok(f.state.providerAuth);
      f.state.providerAuth.auth.apiKey = "new-secret";
      assert.equal(sameCompactionBinding(first.binding, (await f.resolve()).binding), false);
    });
  }

  test("authentication failures and lost ownership still reject before binding", async () => {
    const f = fixture();
    f.state.auth = { ok: false, error: "fixture resolution failure" };
    await assert.rejects(f.resolve(), /fixture resolution failure/);
    f.state.auth = { ok: true, apiKey: "fixture-secret-request-key" };
    await assert.rejects(
      f.resolve(() => false),
      { name: "AbortError" },
    );
    f.ctx.modelRegistry.getProviderAuth = async () => {
      throw new Error("provider auth failed");
    };
    await assert.rejects(f.resolve(), /provider auth failed/);
  });

  test("explicit context-management checks ownership after provider authentication await", async () => {
    const f = fixture();
    f.state.settings.protocol = "context-management";
    let current = true;
    f.ctx.modelRegistry.getProviderAuth = async () => {
      current = false;
      return f.state.providerAuth;
    };
    await assert.rejects(
      f.resolve(() => current),
      { name: "AbortError" },
    );
  });

  test("model headers are attributed to the model rather than request authentication", async () => {
    const f = fixture();
    const first = await f.resolve();
    f.state.model = { ...f.state.model, headers: { "OpenAI-Project": "fixture-project" } };
    const second = await f.resolve();
    assert.deepEqual(second.route, first.route);
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), ["model changed"]);
  });

  test("provider authentication provenance changes are distinct from request authentication", async () => {
    const f = fixture();
    f.state.providerAuth = { source: "stored credential", auth: { apiKey: "fixture-secret-request-key" } };
    const first = await f.resolve();
    f.state.providerAuth = { source: "runtime", auth: { apiKey: "fixture-secret-request-key" } };
    const second = await f.resolve();
    assert.deepEqual(second.route, first.route);
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), ["provider authentication changed"]);
  });

  test("protocol changes report route changes independently of model and authentication", async () => {
    const f = fixture();
    f.state.providerAuth = undefined;
    const first = await f.resolve();
    f.state.settings.protocol = "remote-v2";
    const second = await f.resolve();
    assert.equal(first.route.protocol, "responses-compact");
    assert.equal(second.route.protocol, "remote-v2");
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), ["route changed"]);
  });

  test("recomposing a provider with the same functions reports only provider identity", async () => {
    const f = fixture();
    const first = await f.resolve();
    f.state.provider = { ...f.state.provider };
    const second = await f.resolve();
    assert.equal(first.binding.key, second.binding.key);
    assert.equal(sameCompactionBinding(first.binding, second.binding), false);
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), ["provider instance changed"]);
  });

  for (const method of ["stream", "streamSimple"] as const) {
    test(`replacing ${method} on the same provider reports only its function identity`, async () => {
      const f = fixture();
      const first = await f.resolve();
      f.state.provider[method] = () => {
        throw new Error("replacement unused");
      };
      const second = await f.resolve();
      assert.equal(first.binding.provider, second.binding.provider);
      assert.equal(first.binding.key, second.binding.key);
      assert.equal(sameCompactionBinding(first.binding, second.binding), false);
      assert.deepEqual(compactionBindingChanges(first.binding, second.binding), [`${method} function changed`]);
    });
  }

  test("all changed components are reported once in deterministic order", async () => {
    const f = fixture();
    const first = await f.resolve();
    f.state.model = { ...f.state.model, id: "different-model" };
    f.state.settings.protocol = "remote-v2";
    f.state.auth = { ok: true, apiKey: "fixture-secret-rotated-key" };
    f.state.providerAuth = { source: "runtime", auth: { apiKey: "fixture-secret-rotated-key" } };
    f.state.provider = {
      ...f.state.provider,
      stream() {
        throw new Error("replacement unused");
      },
      streamSimple() {
        throw new Error("replacement unused");
      },
    };
    const second = await f.resolve();
    const changes = [
      "model changed",
      "route changed",
      "request authentication changed",
      "provider authentication changed",
      "provider instance changed",
      "stream function changed",
      "streamSimple function changed",
    ];
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), changes);
    assert.deepEqual(compactionBindingChanges(second.binding, first.binding), changes);
  });

  test("missing prepared bindings and legacy bindings retain useful fallback reasons", async () => {
    const f = fixture();
    const { binding } = await f.resolve();
    assert.deepEqual(compactionBindingChanges(undefined, binding), ["prepared binding unavailable"]);
    assert.deepEqual(compactionBindingChanges({ ...binding, key: "legacy-key" }, binding), ["binding changed"]);
    assert.deepEqual(compactionBindingChanges(binding, { ...binding, key: "legacy-key" }), ["binding changed"]);
    const second = await f.resolve();
    second.binding.key = "changed-key-with-unchanged-components";
    assert.deepEqual(compactionBindingChanges(binding, second.binding), ["binding changed"]);
  });

  test("diagnostics preserve every combination of the original acceptance guards", async () => {
    const f = fixture();
    const { binding } = await f.resolve();
    const replacement = fixture().state.provider;
    for (let mask = 0; mask < 16; mask += 1) {
      const right: CompactionBinding = {
        key: mask & 1 ? "different-key" : binding.key,
        provider: mask & 2 ? replacement : binding.provider,
        stream: mask & 4 ? replacement.stream : binding.stream,
        streamSimple: mask & 8 ? replacement.streamSimple : binding.streamSimple,
      };
      const expected = originalComparator(binding, right);
      assert.equal(expected, mask === 0);
      assert.equal(sameCompactionBinding(binding, right), expected);
      assert.equal(compactionBindingChanges(binding, right).length === 0, expected);
    }
    assert.equal(sameCompactionBinding(undefined, binding), originalComparator(undefined, binding));
  });

  test("private diagnostic differences cannot override acceptance by the original guards", async () => {
    const f = fixture();
    const first = await f.resolve();
    f.state.model = { ...f.state.model, id: "different-model" };
    const second = await f.resolve();
    second.binding.key = first.binding.key;
    assert.equal(originalComparator(first.binding, second.binding), true);
    assert.equal(sameCompactionBinding(first.binding, second.binding), true);
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), []);
  });

  test("stateful serialization hooks run once per resolution with no extra authentication lookup", async () => {
    const f = fixture();
    const counts = { model: 0, requestAuth: 0, providerAuth: 0 };
    const originalModel = structuredClone(f.state.model);
    const originalAuth = structuredClone(f.state.auth);
    const originalProviderAuth = structuredClone(f.state.providerAuth);
    Object.assign(f.state.model, {
      toJSON: () => ({ ...originalModel, id: `serialized-model-${++counts.model}` }),
    });
    Object.assign(f.state.auth, {
      toJSON: () => ({ ...originalAuth, apiKey: `serialized-request-${++counts.requestAuth}` }),
    });
    assert.ok(f.state.providerAuth);
    Object.assign(f.state.providerAuth, {
      toJSON: () => ({ ...originalProviderAuth, source: `serialized-provider-${++counts.providerAuth}` }),
    });
    const first = await f.resolve();
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          { ...originalModel, id: "serialized-model-1" },
          first.route,
          { ...originalAuth, apiKey: "serialized-request-1" },
          { ...originalProviderAuth, source: "serialized-provider-1" },
          [
            f.state.settings.appendMaintenanceMessage,
            f.state.settings.maintenanceMessage,
            f.state.settings.scratchpadEnabled,
          ],
        ]),
      )
      .digest("hex");
    assert.equal(first.binding.key, expected);
    assert.deepEqual(counts, { model: 1, requestAuth: 1, providerAuth: 1 });
    const second = await f.resolve();
    assert.deepEqual(counts, { model: 2, requestAuth: 2, providerAuth: 2 });
    assert.deepEqual(f.calls, { requestAuth: 2, providerAuth: 2 });
    assert.deepEqual(compactionBindingChanges(first.binding, second.binding), [
      "model changed",
      "request authentication changed",
      "provider authentication changed",
    ]);
  });

  test("bindings expose no additional properties or authentication material", async () => {
    const f = fixture();
    const { binding } = await f.resolve();
    const originalKeys = ["key", "provider", "stream", "streamSimple"];
    assert.deepEqual(Object.keys(binding), originalKeys);
    assert.deepEqual(Reflect.ownKeys(binding), originalKeys);
    assert.doesNotMatch(JSON.stringify(binding), /fixture-secret|componentDigests|requestAuth|providerAuth/);
    assert.match(binding.key, /^[a-f0-9]{64}$/);
  });
});

for (const field of ["appendMaintenanceMessage", "maintenanceMessage"] as const) {
  test(`maintenance configuration invalidates request binding: ${field}`, async () => {
    const f = fixture();
    const first = await f.resolve();
    if (field === "appendMaintenanceMessage") f.state.settings.appendMaintenanceMessage = false;
    else f.state.settings.maintenanceMessage = "PRIVATE custom instruction";
    const next = await f.resolve();
    assert.equal(sameCompactionBinding(first.binding, next.binding), false);
    assert.deepEqual(compactionBindingChanges(first.binding, next.binding), ["maintenance settings changed"]);
    assert.ok(!JSON.stringify(next.binding).includes("PRIVATE"));
  });
}
