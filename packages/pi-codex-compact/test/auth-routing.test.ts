import assert from "node:assert/strict";
import type { Api, AuthResult, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { describe, test } from "vitest";
import {
  type CompactionRequestAuth,
  isChatGPTCompactionCandidate,
  resolveAuthenticatedCompactionRoute,
  resolveCompactionRoute,
} from "../src/model-api.js";

const protocols = ["auto", "remote-v2", "responses-compact", "context-management"] as const;
const requestAuth = { apiKey: "synthetic-access-token" };
const oauth: AuthResult = { source: "OAuth", auth: { apiKey: requestAuth.apiKey } };

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    ...overrides,
  };
}

describe("OpenAI ChatGPT OAuth compaction routing", () => {
  for (const protocol of protocols) {
    test(`${protocol}: matching resolved OAuth uses Context Management without changing the preference or identity`, () => {
      const options = Object.freeze({ enabled: true, protocol });
      const activeModel = model();
      const original = structuredClone({ activeModel, requestAuth, oauth });
      assert.deepEqual(resolveAuthenticatedCompactionRoute(activeModel, options, requestAuth, oauth), {
        kind: "remote",
        protocol: "context-management",
        api: "openai-responses",
        profile: "openai-responses-v1",
      });
      assert.equal(options.protocol, protocol);
      assert.deepEqual({ activeModel, requestAuth, oauth }, original);
    });
  }

  test("canonical model and resolved auth endpoints allow an optional trailing slash", () => {
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
      for (const authBaseUrl of [undefined, "https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
        const auth = { ...requestAuth, baseUrl: authBaseUrl };
        assert.equal(isChatGPTCompactionCandidate(model({ baseUrl }), auth), true);
      }
    }
  });

  test("API keys, unknown provenance, and credentials changed during resolution retain every protocol", () => {
    const identities: (AuthResult | undefined)[] = [
      undefined,
      { auth: { apiKey: requestAuth.apiKey } },
      { source: "stored credential", auth: { apiKey: requestAuth.apiKey } },
      { source: "OPENAI_API_KEY", auth: { apiKey: requestAuth.apiKey } },
      { source: "runtime", auth: { apiKey: requestAuth.apiKey } },
      { source: "oauth", auth: { apiKey: requestAuth.apiKey } },
      { source: "OAuth", auth: { apiKey: "different-resolved-token" } },
      { source: "OAuth", auth: {} },
    ];
    for (const providerAuth of identities) {
      for (const protocol of protocols) {
        const options = { enabled: true, protocol };
        assert.deepEqual(
          resolveAuthenticatedCompactionRoute(model(), options, requestAuth, providerAuth),
          resolveCompactionRoute(model(), options),
        );
      }
    }
  });

  test("missing, empty, and whitespace-only request keys are not OAuth candidates", () => {
    for (const apiKey of [undefined, "", " "]) {
      const auth = { apiKey };
      assert.equal(isChatGPTCompactionCandidate(model(), auth), false);
      assert.deepEqual(
        resolveAuthenticatedCompactionRoute(model(), { enabled: true, protocol: "auto" }, auth, {
          source: "OAuth",
          auth,
        }),
        resolveCompactionRoute(model(), { enabled: true, protocol: "auto" }),
      );
    }
  });

  test("token shape and ambient environment do not replace resolved provenance", () => {
    const authWithEnv = { ...requestAuth, env: { OPENAI_API_KEY: "ambient-key-not-selected" } };
    const selected = resolveAuthenticatedCompactionRoute(
      model(),
      { enabled: true, protocol: "auto" },
      authWithEnv,
      oauth,
    );
    assert.equal(selected.kind === "remote" && selected.protocol, "context-management");
    const jwtShapedKey = "header.payload.signature";
    assert.deepEqual(
      resolveAuthenticatedCompactionRoute(
        model(),
        { enabled: true, protocol: "remote-v2" },
        { apiKey: jwtShapedKey },
        { source: "OPENAI_API_KEY", auth: { apiKey: jwtShapedKey } },
      ),
      resolveCompactionRoute(model(), { enabled: true, protocol: "remote-v2" }),
    );
  });

  test("legacy Codex, Azure, custom providers, custom APIs, and absent models retain existing routing", () => {
    const models = [
      undefined,
      model({ provider: "openai-codex", api: "openai-codex-responses" }),
      model({ provider: "azure-openai", api: "azure-openai-responses" }),
      model({ provider: "company-proxy" }),
      model({ api: "custom-responses" as Api }),
      model({ api: "anthropic-messages" }),
    ];
    for (const activeModel of models) {
      assert.equal(isChatGPTCompactionCandidate(activeModel, requestAuth), false);
      for (const protocol of protocols) {
        const options = {
          enabled: true,
          protocol,
          apiProfiles: { "custom-responses": "codex-responses-v1" as const },
        };
        assert.deepEqual(
          resolveAuthenticatedCompactionRoute(activeModel, options, requestAuth, oauth),
          resolveCompactionRoute(activeModel, options),
        );
      }
    }
  });

  test("disabled remote compaction stays native with verified OAuth", () => {
    for (const protocol of protocols) {
      const options = { enabled: false, protocol };
      assert.deepEqual(
        resolveAuthenticatedCompactionRoute(model(), options, requestAuth, oauth),
        resolveCompactionRoute(model(), options),
      );
    }
  });

  test("custom, ambiguous, and credential-bearing endpoints do not opt into OAuth routing", () => {
    for (const baseUrl of [
      "",
      "https://proxy.example/v1",
      "http://api.openai.com/v1",
      "https://api.openai.com.example/v1",
      "https://api.openai.com/v2",
      "https://api.openai.com/v1//",
      "https://api.openai.com/v1?route=custom",
      "https://api.openai.com/v1#custom",
      "https://user:secret@api.openai.com/v1",
      "https://api.openai.com:8443/v1",
    ]) {
      for (const [activeModel, auth] of [
        [model({ baseUrl }), requestAuth],
        [model(), { ...requestAuth, baseUrl }],
      ] satisfies [Model<Api>, CompactionRequestAuth][]) {
        assert.equal(isChatGPTCompactionCandidate(activeModel, auth), false);
        for (const protocol of protocols) {
          const options = { enabled: true, protocol };
          assert.deepEqual(
            resolveAuthenticatedCompactionRoute(activeModel, options, auth, oauth),
            resolveCompactionRoute(activeModel, options),
          );
        }
      }
    }
  });

  test("model and request authorization overrides retain protocols regardless of header case or value", () => {
    for (const name of [
      "Authorization",
      "authorization",
      "AUTHORIZATION",
      "cf-aig-authorization",
      "Cf-Aig-Authorization",
    ]) {
      for (const value of [`Bearer ${requestAuth.apiKey}`, "Bearer explicit-api-key", null]) {
        const headers: ProviderHeaders = { [name]: value };
        const cases: [Model<Api>, CompactionRequestAuth][] = [[model(), { ...requestAuth, headers }]];
        if (value !== null) cases.push([model({ headers: { [name]: value } }), requestAuth]);
        for (const [activeModel, auth] of cases) {
          assert.equal(isChatGPTCompactionCandidate(activeModel, auth), false);
          for (const protocol of protocols) {
            const options = { enabled: true, protocol };
            assert.deepEqual(
              resolveAuthenticatedCompactionRoute(activeModel, options, auth, oauth),
              resolveCompactionRoute(activeModel, options),
            );
          }
        }
      }
    }
  });

  test("ordinary model and request headers preserve OAuth eligibility", () => {
    assert.equal(
      isChatGPTCompactionCandidate(model({ headers: { "User-Agent": "fixture" } }), {
        ...requestAuth,
        headers: { "OpenAI-Organization": "org_fixture", "OpenAI-Project": "project_fixture" },
      }),
      true,
    );
  });
});
