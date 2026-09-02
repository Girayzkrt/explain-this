import type { Page } from "@playwright/test";
import { RECOMMENDED_MODEL } from "../../src/shared/constants";
import { expect, test } from "./e2e-fixture";

const completedSettings = {
  settings: {
    onboardingVersion: 1,
    preferences: {
      preferredLanguage: "en-US",
      explanationLevel: "everyday",
      preserveEnglishTerms: true,
      includeNearbyContext: false,
      selectedProvider: "ollama",
      selectedModel: RECOMMENDED_MODEL,
      automaticToolbar: true,
      blockedSites: [],
    },
  },
};

async function selectNestedPassage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const start = document.getElementById("selection-start")?.firstChild;
    const end = document.getElementById("selection-end")?.firstChild;
    if (!start || !end)
      throw new Error("Known nested selection fixture is unavailable.");
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function selectSecondTabPassage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const text = document.getElementById("second-selection")?.firstChild;
    if (!text) throw new Error("Known second-tab fixture is unavailable.");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function chatCount(requests: readonly { path: string }[]): number {
  return requests.filter((request) => request.path === "/api/chat").length;
}

function actionMarker(request: unknown): string | undefined {
  if (!request || typeof request !== "object") return undefined;
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return undefined;
  const user = messages[1];
  if (!user || typeof user !== "object") return undefined;
  const content = (user as { content?: unknown }).content;
  return typeof content === "string"
    ? content.match(/Requested action: ([^.]+)\./)?.[1]
    : undefined;
}

async function releaseAfterVisibleDelta(
  page: Page,
  release: () => void,
): Promise<void> {
  const explanation = page.getByRole("article", { name: "Local explanation" });
  await expect(explanation).toContainText("Local");
  release();
  await expect(explanation).toContainText("Local answer.");
}

test.beforeEach(async ({ e2e }) => {
  await e2e.reset();
  await e2e.extension.writeTrustedStorage(completedSettings);
});

test("invokes the packaged shortcut and runs every primary toolbar action from a nested real Range", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(page);
  await e2e.extension.invokePackagedReader(page);
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());
  expect(actionMarker(e2e.ollama.requests.at(-1)?.body)).toBe("explain");
  await page.getByRole("button", { name: "Close explanation" }).click();

  for (const [label, action] of [
    ["Explain", "explain"],
    ["Simplify", "simplify"],
    ["Translate (experimental)", "translate"],
    ["Example", "example"],
  ] as const) {
    await selectNestedPassage(page);
    await page.locator("#selection-end").dispatchEvent("mouseup");
    await expect(
      page.getByRole("toolbar", { name: "Explain selected text" }),
    ).toBeVisible();
    const before = chatCount(e2e.ollama.requests);
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => chatCount(e2e.ollama.requests)).toBe(before + 1);
    await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());
    const request = e2e.ollama.requests.at(-1);
    expect(actionMarker(request?.body)).toBe(action);
    await page.getByRole("button", { name: "Close explanation" }).click();
  }
});

test("stops an in-flight stream then retries a recoverable failed stream", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "idle-stream" });
  await e2e.extension.invokePackagedReader(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await e2e.ollama.waitForCancellation("/api/chat");
  await expect(page.getByText("Incomplete output")).toBeVisible();

  await page.getByRole("button", { name: "Close explanation" }).click();
  await selectNestedPassage(page);
  e2e.ollama.setScenario({ chat: "malformed-partial" });
  await e2e.extension.invokePackagedReader(page);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  e2e.ollama.setScenario({ chat: "normal" });
  await page.getByRole("button", { name: "Try again" }).click();
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());
});

test("opens the side-panel flow and sends every bounded follow-up intent", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);
  await e2e.extension.invokePackagedReader(page);
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());

  await page.getByRole("button", { name: "Open in side panel" }).click();
  const panel = await e2e.extension.openSidePanel(page);
  await expect(panel.getByRole("heading", { name: "Explain This" })).toBeVisible();

  for (const [label, intent] of [
    ["Simpler", "simpler"],
    ["More detail", "more-detail"],
    ["Why?", "why"],
    ["Another example", "another-example"],
  ] as const) {
    const before = chatCount(e2e.ollama.requests);
    await panel.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => chatCount(e2e.ollama.requests)).toBe(before + 1);
    const request = e2e.ollama.requests.at(-1);
    expect(actionMarker(request?.body)).toBe(intent);
    const explanation = panel.getByRole("region", { name: "Explanation" });
    await expect(explanation).toContainText("Local");
    e2e.ollama.releaseChat();
    await expect(explanation).toContainText("Local answer.");
  }
});

test("replaces a first-tab generation when a second tab begins one", async ({
  e2e,
}) => {
  const first = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  const second = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(first);
  e2e.ollama.setScenario({ chat: "slow-first-token" });
  await e2e.extension.invokePackagedReader(first);
  await expect(first.getByRole("button", { name: "Stop" })).toBeVisible();

  await selectSecondTabPassage(second);
  e2e.ollama.setScenario({ chat: "normal" });
  await e2e.extension.invokePackagedReader(second);

  await e2e.ollama.waitForCancellation("/api/chat");
  await expect(first.getByText("Incomplete output")).toBeVisible();
  await releaseAfterVisibleDelta(second, () => e2e.ollama.releaseChat());
});

test("keeps the surface isolated above hostile CSS and inside the viewport", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("hostile.html"));
  await page.setViewportSize({ width: 1280, height: 720 });
  const geometry = await page.evaluate(() => {
    const target = document.getElementById("hostile-selection");
    const text = target?.firstChild;
    if (!text) throw new Error("Known hostile selection fixture is unavailable.");
    target.style.position = "fixed";
    target.style.right = "0";
    target.style.bottom = "0";
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const rect = range.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });

  await e2e.extension.invokePackagedReader(page);
  const result = await page.locator("explain-this-reader").evaluate((host) => {
    const surface = host.shadowRoot?.querySelector<HTMLElement>(".reader-surface");
    if (!surface) throw new Error("Reader surface is unavailable.");
    const style = getComputedStyle(surface);
    const bounds = surface.getBoundingClientRect();
    return {
      fontFamily: style.fontFamily,
      position: style.position,
      zIndex: style.zIndex,
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.width,
    };
  });

  expect(result.position).toBe("fixed");
  expect(result.zIndex).toBe("2147483647");
  expect(result.fontFamily).not.toContain("fantasy");
  expect(result.left).toBeGreaterThanOrEqual(8);
  expect(result.top).toBeGreaterThanOrEqual(8);
  expect(result.right).toBeLessThanOrEqual(geometry.width - 8);
  expect(result.bottom).toBeLessThanOrEqual(geometry.height - 8);
  expect(result.width).toBeLessThanOrEqual(416);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);

  await page.getByRole("button", { name: "Close explanation" }).click();
  await page.locator("#hostile-selection").dispatchEvent("mouseup");
  const toolbar = page.getByRole("toolbar", { name: "Explain selected text" });
  await expect(toolbar).toBeVisible();
  const toolbarBounds = await page.locator("explain-this-reader").evaluate((host) => {
    const surface = host.shadowRoot?.querySelector<HTMLElement>(".reader-surface");
    if (!surface) throw new Error("Reader toolbar surface is unavailable.");
    const { left, right } = surface.getBoundingClientRect();
    return { left, right };
  });
  expect(toolbarBounds.right).toBeLessThanOrEqual(geometry.width - 8);

  await page.setViewportSize({ width: 400, height: 720 });
  await page.locator("#hostile-selection").dispatchEvent("mouseup");
  const narrowBounds = await page.locator("explain-this-reader").evaluate((host) => {
    const surface = host.shadowRoot?.querySelector<HTMLElement>(".reader-surface");
    if (!surface) throw new Error("Narrow reader toolbar surface is unavailable.");
    const { left, right } = surface.getBoundingClientRect();
    return { left, right };
  });
  expect(narrowBounds.left).toBeGreaterThanOrEqual(8);
  expect(narrowBounds.right).toBeLessThanOrEqual(392);
});
