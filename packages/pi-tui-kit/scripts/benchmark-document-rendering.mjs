import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createDocumentLineCache } from "../dist/components/document-formatting.js";

// Run serially after a Kit build. This measures complete search preparation, not only lexing.
const documents = {
  prose: Array.from(
    { length: 24 },
    (_, index) =>
      `## Section ${index}\n\nA **styled** paragraph with a [link](https://example.test), inline \`code\`, 你🙂, and repeated search words.\n\n> Quoted text with *emphasis*.\n\n- First list item\n- Second list item\n`,
  ).join("\n"),
  tables: Array.from(
    { length: 12 },
    (_, index) =>
      `## Table ${index}\n\n| Name | Description |\n| --- | --- |\n| 你🙂 | A long cell with multiple words and search coordinates across wrapped rows |\n| entry | Another **styled** cell |\n\n\`\`\`text\n  exact  spacing\n\`\`\`\n`,
  ).join("\n"),
};
const results = [];
for (const [document, content] of Object.entries(documents)) {
  for (const workload of ["search-preparation", "alternating-width", "theme-invalidation"]) {
    const samples = [];
    const hashes = [];
    for (let sample = -1; sample < 7; sample += 1) {
      let light = false;
      const theme = {
        fg: (_role, text) => `\u001b[${light ? 32 : 31}m${text}\u001b[0m`,
        bold: (text) => `\u001b[1m${text}\u001b[22m`,
      };
      const cache = createDocumentLineCache(theme, true);
      const format = { kind: "markdown", renderMermaid: false };
      cache.presentation(content, format, 60);
      const frames = [];
      const started = performance.now();
      for (let iteration = 0; iteration < 8; iteration += 1) {
        if (workload === "search-preparation") cache.invalidate();
        if (workload === "theme-invalidation") {
          light = !light;
          cache.invalidate();
        }
        frames.push(cache.presentation(content, format, workload === "alternating-width" && iteration % 2 ? 80 : 60));
      }
      const elapsed = performance.now() - started;
      if (sample >= 0) {
        samples.push(elapsed);
        hashes.push(createHash("sha256").update(JSON.stringify(frames)).digest("hex"));
      }
    }
    if (new Set(hashes).size !== 1) throw new Error("Non-deterministic output");
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const middle = median(samples);
    results.push({
      document,
      workload,
      medianMs: middle,
      madMs: median(samples.map((n) => Math.abs(n - middle))),
      samplesMs: samples,
      outputSha256: hashes[0],
    });
  }
}
console.log(JSON.stringify({ iterations: 8, samples: 7, results }, null, 2));
