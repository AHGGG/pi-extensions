import assert from "node:assert/strict";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { beforeEach, test, vi } from "vitest";
import type { ProviderOwnedOAuth } from "../src/oauth.js";

beforeEach(() => vi.resetModules());

const credential: OAuthCredential = {
  type: "oauth",
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: 2_000_000_000_000,
};

function providerOAuth(): ProviderOwnedOAuth {
  return {
    login: async () => credential,
    refresh: async (current) => current,
    toAuth: async (current) => ({ apiKey: current.access }),
  };
}

function operations(oauth: ProviderOwnedOAuth) {
  return [
    oauth.login({ signal: new AbortController().signal, prompt: async () => "", notify: () => {} }, undefined),
    oauth.refresh(credential, new AbortController().signal),
    oauth.toAuth(credential),
  ];
}

function assertRejected(results: PromiseSettledResult<unknown>[], expected: Error) {
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, expected);
  }
}

for (const failure of ["loader rejection", "enumeration throws", "missing provider", "missing OAuth"] as const) {
  test(`lazy OAuth retries after ${failure} and shares each concurrent lookup`, async () => {
    const { createBuiltinProviderAdapters } = await import("../src/oauth.js");
    let calls = 0;
    let healthy = false;
    const error = new Error("fixture lookup failure");
    const oauth = providerOAuth();
    const adapter = createBuiltinProviderAdapters({
      loader: async () => {
        calls++;
        if (!healthy && failure === "loader rejection") throw error;
        return {
          builtinProviders: () => {
            if (healthy) return [{ id: "openai", auth: { oauth } }];
            if (failure === "enumeration throws") throw error;
            return failure === "missing provider" ? [] : [{ id: "openai", auth: {} }];
          },
        };
      },
    }).find((candidate) => candidate.id === "openai");
    assert.ok(adapter);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const pending = operations(adapter.oauth);
      const callsWhilePending = calls;
      const results = await Promise.allSettled(pending);
      assert.equal(callsWhilePending, attempt);
      assert.equal(calls, attempt);
      const expected = results[0];
      assert.equal(expected?.status, "rejected");
      if (expected?.status !== "rejected") throw new Error("Expected lookup failure");
      if (failure === "loader rejection" || failure === "enumeration throws") {
        assert.equal(expected.reason, error);
      } else {
        assert.equal(expected.reason.message, "Pi's built-in openai OAuth provider is unavailable.");
      }
      assertRejected(results, expected.reason);
    }

    healthy = true;
    assert.deepEqual(await Promise.all(operations(adapter.oauth)), [
      credential,
      credential,
      { apiKey: credential.access },
    ]);
    assert.equal(calls, 3);
    await Promise.all(operations(adapter.oauth));
    assert.equal(calls, 3, "successful lookup must stay cached");
  });
}

test("a rejected provider lookup does not evict another provider's successful lookup", async () => {
  const { createBuiltinProviderAdapters } = await import("../src/oauth.js");
  let calls = 0;
  let healthy = false;
  const oauth = providerOAuth();
  const adapters = createBuiltinProviderAdapters({
    loader: async () => {
      calls++;
      return {
        builtinProviders: () => [
          { id: "meta", auth: { oauth } },
          { id: "openai", auth: healthy ? { oauth } : {} },
        ],
      };
    },
  });
  const meta = adapters.find((adapter) => adapter.id === "meta");
  const openai = adapters.find((adapter) => adapter.id === "openai");
  assert.ok(meta && openai);
  await meta.oauth.toAuth(credential);
  await assert.rejects(openai.oauth.toAuth(credential), /OAuth provider is unavailable/u);
  healthy = true;
  await openai.oauth.toAuth(credential);
  await meta.oauth.toAuth(credential);
  assert.equal(calls, 3);
});

for (const method of ["login", "refresh", "toAuth"] as const) {
  test(`an OAuth ${method} failure does not evict a successful provider lookup`, async () => {
    const { createBuiltinProviderAdapters } = await import("../src/oauth.js");
    let calls = 0;
    let failing = true;
    const error = new Error("fixture OAuth operation failure");
    const oauth = providerOAuth();
    const check = (operation: keyof ProviderOwnedOAuth) => {
      if (failing && operation === method) throw error;
    };
    const wrapped: ProviderOwnedOAuth = {
      login: async (...args) => {
        check("login");
        return oauth.login(...args);
      },
      refresh: async (...args) => {
        check("refresh");
        return oauth.refresh(...args);
      },
      toAuth: async (...args) => {
        check("toAuth");
        return oauth.toAuth(...args);
      },
    };
    const adapter = createBuiltinProviderAdapters({
      loader: async () => {
        calls++;
        return { builtinProviders: () => [{ id: "openai", auth: { oauth: wrapped } }] };
      },
    }).find((candidate) => candidate.id === "openai");
    assert.ok(adapter);
    const results = await Promise.allSettled(operations(adapter.oauth));
    const index = ["login", "refresh", "toAuth"].indexOf(method);
    const result = results[index];
    assert.ok(result);
    assertRejected([result], error);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    failing = false;
    await Promise.all(operations(adapter.oauth));
    assert.equal(calls, 1);
  });
}
