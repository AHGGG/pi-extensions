import { expect, type Page, test } from "@playwright/test";
import { Collector } from "../src/collector.js";
import type { Snapshot } from "../src/model.js";
import { branch, detail, snapshot } from "../src/projection.js";
import { startServer, type ViewerServer } from "../src/server.js";
import { fixture, skills, tools } from "./fixtures.js";

let server: ViewerServer;
let f: ReturnType<typeof fixture>;
let value: Snapshot;
test.beforeEach(async () => {
  f = fixture();
  const collector = new Collector();
  value = snapshot(f.manager, collector, "environment", 0, "current prompt", tools, ["read"], skills);
  value.mcp = { servers: [{ name: "registered-with-no-tools", truncated: false }], truncated: false };
  server = await startServer({
    generation: "environment",
    signal: new AbortController().signal,
    snapshot: () => value,
    branch: (id, offset) => branch(f.manager, id, offset, skills),
    detail: (id, leaf) => detail(f.manager, id, leaf, collector),
  });
});
test.afterEach(async () => server.close());
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const resource = (page: Page) => page.locator(".resource-panel:not([hidden])");

for (const width of [1672, 1115, 900, 375]) {
  test(`two navigation levels, resource state and safe rendering at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(server.origin)) external.push(request.url());
    });
    const firstTool = value.tools[0];
    if (!firstTool) throw Error("Missing tool fixture");
    value.tools[0] = {
      ...firstTool,
      name: "long-".repeat(100),
      description: "<script>window.unsafe=true</script>",
      metadataTruncated: true,
    };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(server.url);
    const primary = page.getByRole("tablist", { name: "Inspection source" });
    await expect(primary.getByRole("tab")).toHaveText(["Context", "Session", "Cache", "Environment"]);
    const header = await page.locator(".app-header").boundingBox();
    const tabs = await primary.boundingBox();
    expect(tabs?.y).toBeGreaterThanOrEqual((header?.y ?? 0) + (header?.height ?? 0));
    await expect(page.locator(".environment-surface .inventory-card")).toHaveCount(0);
    await tab(page, "Context").focus();
    await page.keyboard.press("End");
    await expect(tab(page, "Environment")).toBeFocused();
    await expect(tab(page, "Environment")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "Context")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Environment")).toBeFocused();
    const secondary = page.getByRole("tablist", { name: "Environment resources" });
    await expect(secondary.getByRole("tab")).toHaveText(["Tools", "MCP Servers", "Skills"]);
    await expect(resource(page)).toContainText("active ≠ provider-visible");
    await expect(resource(page)).toContainText("<script>window.unsafe=true</script>");
    await expect(resource(page)).toContainText("Tool metadata truncated");
    await expect(resource(page).locator("script")).toHaveCount(0);
    await tab(page, "Tools").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(page, "MCP Servers")).toBeFocused();
    await expect(tab(page, "Environment")).toHaveAttribute("aria-selected", "true");
    await expect(resource(page)).toContainText("registered-with-no-tools");
    await expect(resource(page)).toContainText("Connection status: unavailable");
    await expect(resource(page)).not.toContainText("mcp__docs__search");
    await page.keyboard.press("End");
    await expect(tab(page, "Skills")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tab(page, "Tools")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(tab(page, "Skills")).toBeFocused();
    await expect(resource(page)).toContainText("Skill content unavailable");
    await resource(page).getByRole("button", { name: "Path · example", exact: true }).click();
    await expect(resource(page)).toContainText("/skills/example/SKILL.md");
    await tab(page, "Session").click();
    await expect(page.getByRole("textbox", { name: "Search session" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await tab(page, "Environment").click();
    await expect(tab(page, "Skills")).toHaveAttribute("aria-selected", "true");
    await expect(resource(page).getByRole("button", { name: "Path · example", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await tab(page, "Tools").click();
    await page.getByRole("button", { name: "Toggle appearance" }).click();
    await expect(page.locator(".inspector-app")).toHaveClass(/dark/);
    for (const name of ["Tools", "MCP Servers", "Skills"]) {
      await tab(page, name).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`environment-${name.replaceAll(" ", "-").toLowerCase()}.png`),
        animations: "disabled",
      });
    }
    expect(f.manager.getLeafId()).toBe(value.leafId);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}

for (const width of [320, 375, 900, 1672]) {
  test(`compact resource layout, readable themes and keyboard disclosures at ${width}px`, async ({ page, context }) => {
    const tool = value.tools[0];
    if (!tool) throw Error("Missing tool fixture");
    const description =
      "Inspect the current session without changing its data. Tool descriptions remain fully available for review.\n\nParameters and source metadata are available below.\n" +
      "long_unbroken_description_".repeat(12);
    value.tools = Array.from({ length: 12 }, (_, index) => ({
      ...tool,
      name: `inspect_session_${index}`,
      description,
      active: index % 2 === 0,
      callable: index % 2 === 0,
    }));
    await page.setViewportSize({ width, height: 812 });
    await page.goto(server.url);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    await tab(page, "Environment").click();
    const panel = resource(page);
    const card = panel.locator(".inventory-card").first();
    const schema = card.getByRole("button", { name: "Schema · inspect_session_0", exact: true });
    const source = card.getByRole("button", { name: "Source · inspect_session_0", exact: true });
    await expect(source).toHaveAttribute("aria-expanded", "false");
    await expect(schema).toHaveAttribute("aria-expanded", "false");
    await expect(panel.locator(".json-tree")).toHaveCount(0);
    await expect(card.locator(".inventory-description")).toHaveText(description);
    for (const selector of [
      ".environment-surface",
      ".inventory-card",
      ".inventory-description",
      ".inventory-card .rt-Heading",
    ]) {
      await expect(page.locator(selector).first()).toHaveCSS("font-family", /monospace/);
    }
    await expect(card.locator(".rt-Heading")).toHaveCSS("font-size", "13px");
    await expect(page.locator(".inspector-app")).toHaveCSS("font-family", /monospace/);
    await expect(page.locator(".app-header")).toHaveCSS("height", width <= 680 ? "80px" : "64px");
    await expect(page.locator(".app-footer")).toHaveCSS("height", "34px");

    for (const appearance of ["light", "dark"]) {
      await expect(page.locator(".inspector-app")).toHaveClass(new RegExp(appearance));
      const background = appearance === "light" ? "rgb(245, 242, 235)" : "rgb(32, 35, 39)";
      await expect(page.locator(".inspector-app")).toHaveCSS("background-color", background);
      await expect(card).toHaveCSS(
        "background-color",
        appearance === "light" ? "rgb(250, 248, 243)" : "rgb(38, 41, 46)",
      );
      await expect(page.locator(".brand-logo")).toHaveCSS("background-color", "rgb(183, 203, 234)");
      const primary = page.getByRole("tablist", { name: "Inspection source" });
      await expect(primary).toHaveCSS(
        "background-color",
        appearance === "light" ? "rgb(238, 235, 228)" : "rgb(46, 50, 55)",
      );
      const secondary = page.getByRole("tablist", { name: "Environment resources" });
      await page.keyboard.press("Tab");
      for (const [selected, other] of [
        [primary.getByRole("tab", { name: "Environment" }), primary.getByRole("tab", { name: "Context" })],
        [secondary.getByRole("tab", { name: "Tools", exact: true }), secondary.getByRole("tab", { name: "Skills" })],
      ] as const) {
        expect(await selected.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
          await other.evaluate((element) => getComputedStyle(element).backgroundColor),
        );
        await selected.focus();
        await expect(selected).toHaveCSS("outline-style", "solid");
        await expect(selected).toHaveCSS("outline-width", "2px");
      }
      const inactiveTab = secondary.getByRole("tab", { name: "Skills" });
      const idleBackground = await inactiveTab.evaluate((element) => getComputedStyle(element).backgroundColor);
      await inactiveTab.hover();
      expect(await inactiveTab.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        idleBackground,
      );
      const idleDisclosure = await schema.evaluate((element) => getComputedStyle(element).backgroundColor);
      await schema.hover();
      expect(await schema.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(idleDisclosure);
      // Composite alpha backgrounds through the actual theme before checking normal-size text.
      const contrasts = await page
        .locator(
          ".environment-heading p, .resource-panel > p, " +
            ".inventory-card:first-of-type .rt-Badge, .inventory-card:first-of-type .section-toggle, " +
            ".inventory-card:first-of-type .copy-button, .environment-surface .navigation-tabs button",
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.getClientRects().length)
            .map((element) => {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const ctx = canvas.getContext("2d");
              if (!ctx) throw Error("Canvas unavailable");
              const parents: Element[] = [];
              for (let parent: Element | null = element; parent; parent = parent.parentElement) parents.unshift(parent);
              ctx.fillStyle = "white";
              ctx.fillRect(0, 0, 1, 1);
              for (const parent of parents) {
                ctx.fillStyle = getComputedStyle(parent).backgroundColor;
                ctx.fillRect(0, 0, 1, 1);
              }
              const luminance = (data: Uint8ClampedArray) => {
                const linear = Array.from(data.slice(0, 3), (value) => {
                  const channel = value / 255;
                  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                });
                return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
              };
              const background = luminance(ctx.getImageData(0, 0, 1, 1).data);
              ctx.fillStyle = getComputedStyle(element).color;
              ctx.fillRect(0, 0, 1, 1);
              const foreground = luminance(ctx.getImageData(0, 0, 1, 1).data);
              return {
                text: element.textContent,
                ratio: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
              };
            }),
        );
      for (const { text, ratio } of contrasts) expect(ratio, `${appearance}: ${text}`).toBeGreaterThanOrEqual(4.5);
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
      const bounds = await card.boundingBox();
      expect(bounds?.width).toBeLessThanOrEqual(1040);
      expect(
        Number.parseFloat(await card.evaluate((element) => getComputedStyle(element).paddingLeft)),
      ).toBeGreaterThanOrEqual(12);
      if (width > 680) {
        await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
        await expect(page.locator(".app-footer span").last()).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollY === 0)).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`resources-${width}-${appearance}.png`),
        animations: "disabled",
      });
      if (appearance === "light") await page.getByRole("button", { name: "Toggle appearance" }).click();
    }

    await schema.focus();
    await page.keyboard.press("Enter");
    await expect(schema).toHaveAttribute("aria-expanded", "true");
    await expect(card.locator(".json-tree")).toHaveCSS("font-family", /monospace/);
    await page.keyboard.press("Tab");
    const copy = card.locator(".data").last().getByRole("button", { name: "Copy display data" });
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(copy).toHaveText("Copied");
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(tool.schema?.value);
    await schema.focus();
    await page.keyboard.press("Space");
    await expect(schema).toHaveAttribute("aria-expanded", "false");
    await expect(source).toHaveAttribute("aria-expanded", "false");
    const last = panel.locator(".inventory-card").last();
    await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(last.getByRole("button", { name: "Copy display data" }).last()).toBeInViewport();
    const lastBounds = await last.boundingBox();
    const footerBounds = await page.locator(".app-footer").boundingBox();
    expect((lastBounds?.y ?? 0) + (lastBounds?.height ?? 0)).toBeLessThanOrEqual(footerBounds?.y ?? 0);
  });
}

for (const appearance of ["light", "dark"]) {
  test(`portaled drawer retains visible keyboard focus in ${appearance} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(server.url);
    if (appearance === "dark") await page.getByRole("button", { name: "Toggle appearance" }).click();
    await tab(page, "Session").click();
    await page.locator(`.session-primary:not([hidden]) [data-trace-id="${f.user}"]`).click();
    const drawer = page.getByRole("dialog", { name: "Event details" });
    await expect(drawer).toBeVisible();
    expect(await drawer.evaluate((element) => element.closest(".inspector-app"))).toBeNull();
    await page.keyboard.press("Tab");
    for (const button of [
      drawer.getByRole("button", { name: "Close Event details" }),
      drawer.getByRole("button", { name: "Copy display data" }).first(),
    ]) {
      await button.focus();
      await expect(button).toHaveCSS("outline-style", "solid");
      await expect(button).toHaveCSS("outline-width", "2px");
      await expect(button).not.toHaveCSS("outline-color", "rgba(0, 0, 0, 0)");
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Toggle event details" })).toBeFocused();
    expect(f.manager.getLeafId()).toBe(value.leafId);
  });
}

test("empty, partial, duplicate and unavailable resource catalogs never imply missing servers or files", async ({
  page,
}) => {
  value.tools = [];
  value.skills = [];
  value.mcp = { servers: [], truncated: false };
  await page.goto(server.url);
  await tab(page, "Environment").click();
  await expect(resource(page)).toContainText("No tools in this snapshot");
  await tab(page, "MCP Servers").click();
  await expect(resource(page)).toContainText("This does not mean no MCP servers exist");
  await tab(page, "Skills").click();
  await expect(resource(page)).toContainText("No skills in the startup catalog");
  const firstSkill = skills[0];
  if (!firstSkill) throw Error("Missing skill fixture");
  value = {
    ...value,
    incomplete: true,
    skills: [firstSkill, { ...firstSkill, path: "/missing/SKILL.md" }],
    mcp: { servers: [], truncated: false, unavailable: true },
  };
  server.invalidate(1);
  await expect(page.locator(".environment-heading")).toContainText("Snapshot incomplete");
  await expect(resource(page).locator(".inventory-card")).toHaveCount(2);
  await expect(resource(page)).toContainText("not verified file availability");
  await tab(page, "MCP Servers").click();
  await expect(resource(page)).toContainText("MCP registration API unavailable");
  value = { ...value, mcp: { servers: [{ name: "x".repeat(512), truncated: true }], truncated: true } };
  server.invalidate(2);
  await expect(resource(page)).toContainText("catalog truncated to 256");
  await expect(resource(page)).toContainText("Server name truncated");
  await server.close();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(resource(page)).toContainText("Connection status: unavailable");
});

test("loading and terminal errors leave resource availability explicit", async ({ page }) => {
  await page.route("**/api/snapshot?**", (route) => route.fulfill({ status: 409, body: "Changed" }));
  await page.goto(server.url);
  await tab(page, "Environment").click();
  await expect(page.getByText("Session expired; open a new viewer from Pi.", { exact: true })).toBeVisible();
  await expect(page.locator(".environment-heading")).toContainText("Resource inventory unavailable");
  await tab(page, "MCP Servers").click();
  await expect(resource(page)).toContainText("complete configured server catalog is unavailable");
});

test("Environment exit cancels pending event work; desktop and drawer share one selection", async ({ page }) => {
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url().includes("/api/detail") });
  await page.route("**/api/detail?**", async (route) => {
    ready();
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(server.url);
    await tab(page, "Session").click();
    await page.locator(`.session-primary:not([hidden]) [data-trace-id="${f.user}"]`).click();
    await admitted;
    await tab(page, "Environment").click();
    release();
    await aborted;
    await expect(page.locator(".inspector-panel")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.unroute("**/api/detail?**");
    await tab(page, "Session").click();
    await expect(page.locator(".recorded-content")).toContainText("first request");
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.getByRole("dialog", { name: "Event details", exact: true })).toBeVisible();
    await expect(page.locator(".inspector-panel")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Toggle event details" })).toBeFocused();
    await tab(page, "Environment").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await tab(page, "Session").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle event details" }).click();
    await expect(page.locator(".recorded-content")).toContainText("first request");
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".inspector-panel")).toHaveCount(1);
    await page.getByRole("button", { name: "Close event details", exact: true }).click();
    await expect(page.getByRole("button", { name: "Toggle event details" })).toBeFocused();
  } finally {
    release();
  }
});
