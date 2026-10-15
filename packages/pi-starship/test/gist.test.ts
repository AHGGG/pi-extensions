import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "vitest";
import { checkGistDocument, createSettingsGist, executeGhApi, fetchSettingsGist, gistId } from "../src/gist.js";

const signal = new AbortController().signal;
const id = "0123456789abcdef0123456789abcdef";
const raw = "# retained comment\nformat = '$model'\nfuture = true\n";

test("Gist references accept IDs and github.com URLs only", () => {
  for (const value of [
    id,
    ` https://gist.github.com/user/${id} `,
    `https://gist.github.com/${id}#file-pi-starship-toml`,
  ]) {
    assert.equal(gistId(value), id);
  }
  for (const value of [
    "--help",
    "../abcde",
    "",
    "abc",
    `http://gist.github.com/u/${id}`,
    `https://gist.github.com.evil/u/${id}`,
    `https://user@gist.github.com/u/${id}`,
    `https://gist.github.com:444/u/${id}`,
    `https://gist.github.com/u/${id}/raw`,
    `https://gist.github.com/u/${id}?x=y`,
    `https://github.example/u/${id}`,
  ]) {
    assert.throws(() => gistId(value), /Gist ID/u);
  }
});

test("upload creates an unlisted Gist with exact raw TOML on stdin", async () => {
  let calls = 0;
  const url = await createSettingsGist(raw, signal, async (args, input, receivedSignal) => {
    calls += 1;
    assert.deepEqual(args, ["/gists", "--method", "POST", "--input", "-"]);
    assert.equal(receivedSignal, signal);
    assert.deepEqual(JSON.parse(input ?? ""), {
      description: "pi-starship footer settings",
      public: false,
      files: { "pi-starship.toml": { content: raw } },
    });
    return JSON.stringify({ public: false, html_url: `https://gist.github.com/user/${id}` });
  });
  assert.equal(calls, 1);
  assert.equal(url, `https://gist.github.com/${id}`);
});

test("import requests only the Gist API and returns the named document unchanged", async () => {
  const actual = await fetchSettingsGist(`https://gist.github.com/user/${id}`, signal, async (args, input) => {
    assert.deepEqual(args, [`/gists/${id}`, "--method", "GET"]);
    assert.equal(input, undefined);
    return JSON.stringify({
      files: { "pi-starship.toml": { content: raw, truncated: false }, "ignore.toml": { content: "bad" } },
    });
  });
  assert.equal(actual, raw);
});

test("import rejects missing, malformed, empty, truncated, and oversized files without raw URL fallback", async () => {
  for (const response of [
    null,
    [],
    {},
    { files: [] },
    { files: { "other.toml": { content: raw } } },
    ...[
      { content: raw, truncated: true, raw_url: "https://evil.invalid" },
      { content: raw },
      { content: 42, truncated: false },
      { content: "", truncated: false },
      { content: "é".repeat(33 * 1024), truncated: false },
    ].map((file) => ({ files: { "pi-starship.toml": file } })),
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchSettingsGist(id, signal, async () => {
        calls += 1;
        return JSON.stringify(response);
      }),
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(fetchSettingsGist(id, signal, async () => "not JSON"));
});

test("upload rejects empty or oversized documents and invalid response links", async () => {
  for (const value of ["", " ", "é".repeat(33 * 1024)]) {
    let called = false;
    await assert.rejects(
      createSettingsGist(value, signal, async () => {
        called = true;
        return "{}";
      }),
    );
    assert.equal(called, false);
  }
  checkGistDocument("x".repeat(64 * 1024));
  for (const response of [
    null,
    {},
    { public: true, html_url: `https://gist.github.com/u/${id}` },
    { public: false, html_url: "https://evil.invalid" },
  ]) {
    await assert.rejects(createSettingsGist(raw, signal, async () => JSON.stringify(response)));
  }
});

test("aborted requests discard late API results", async () => {
  for (const operation of ["fetch", "create"]) {
    const controller = new AbortController();
    const api = async () => {
      controller.abort();
      return JSON.stringify({
        public: false,
        html_url: `https://gist.github.com/u/${id}`,
        files: { "pi-starship.toml": { content: raw, truncated: false } },
      });
    };
    await assert.rejects(
      operation === "fetch"
        ? fetchSettingsGist(id, controller.signal, api)
        : createSettingsGist(raw, controller.signal, api),
    );
  }
});

async function fakeGh(script: string, run: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-gh-"));
  const previous = process.env.PATH;
  writeFileSync(join(root, "gh"), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  process.env.PATH = `${root}${delimiter}${previous ?? ""}`;
  try {
    await run();
  } finally {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("gh transport pins github.com, disables prompts, and uses stdin instead of command arguments", async () => {
  await fakeGh(
    `let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), input, prompt: process.env.GH_PROMPT_DISABLED })));`,
    async () => {
      const response = JSON.parse(await executeGhApi(["/gists", "--method", "POST", "--input", "-"], raw, signal));
      assert.deepEqual(response.args, [
        "api",
        "--hostname",
        "github.com",
        "/gists",
        "--method",
        "POST",
        "--input",
        "-",
      ]);
      assert.equal(response.input, raw);
      assert.equal(response.prompt, "1");
    },
  );
});

test("gh transport bounds output and hides stderr on failure", async () => {
  await fakeGh(`process.stdout.write('x'.repeat(600 * 1024));`, async () => {
    await assert.rejects(executeGhApi(["/gists"], undefined, signal), /exceeds 512 KiB/u);
  });
  await fakeGh(`console.error('SECRET_TOKEN'); process.exitCode = 1;`, async () => {
    await assert.rejects(executeGhApi(["/gists"], undefined, signal), (error: Error) => {
      assert.match(error.message, /Gist request failed/u);
      assert.doesNotMatch(error.message, /SECRET_TOKEN/u);
      return true;
    });
  });
});

test("gh transport cancels and reaps its child after a readiness handshake", async () => {
  let ready!: (pid: number) => void;
  const readiness = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const server = createServer((request, response) => {
    ready(Number(request.url?.slice(1)));
    response.end("ready");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await fakeGh(
      `require('node:http').get('http://127.0.0.1:${address.port}/' + process.pid, response => response.resume()); setInterval(() => {}, 1000);`,
      async () => {
        const controller = new AbortController();
        const request = executeGhApi(["/gists"], undefined, controller.signal);
        const pid = await readiness;
        controller.abort();
        await assert.rejects(request, /cancelled/u);
        assert.throws(() => process.kill(pid, 0));
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
