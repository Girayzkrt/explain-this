import type { Page } from "@playwright/test";
import { RECOMMENDED_MODEL } from "../../src/shared/constants";
import { expect, test } from "./e2e-fixture";

/** Markers the fixture page hides in places that must never reach the local model. */
const FORBIDDEN_SOURCE_MARKERS = [
  "FORM_VALUE_SECRET",
  "SCRIPT_SECRET",
  "STYLE_SECRET",
  "DISTANT_PROMPT_INJECTION",
  "Navigation secret",
  "Hidden selected-adjacent injection",
  "ARIA hidden injection",
  "Display hidden injection",
  "Opacity hidden injection",
];

function completedSettings(includeNearbyContext: boolean) {
  return {
    settings: {
      onboardingVersion: 1,
      preferences: {
        preferredLanguage: "en-US",
        explanationLevel: "everyday",
        preserveEnglishTerms: true,
        includeNearbyContext,
        selectedProvider: "ollama-local",
        selectedModel: RECOMMENDED_MODEL,
        automaticToolbar: true,
        blockedSites: [],
      },
    },
  };
}

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

function chatRequests(requests: readonly { path: string; body?: unknown }[]) {
  return requests.filter((request) => request.path === "/api/chat");
}

function userPrompt(body: unknown): string {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages))
    throw new Error("The chat request carried no messages.");
  const content = (messages[1] as { content?: unknown } | undefined)?.content;
  if (typeof content !== "string") {
    throw new Error("The chat request carried no user message.");
  }
  return content;
}

function taggedSection(
  prompt: string,
  tag: "selected_text" | "nearby_context",
): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u").exec(prompt);
  if (!match) throw new Error(`The prompt carried no ${tag} section.`);
  return match[1] ?? "";
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
});

test("sends only the selected passage when nearby context stays off", async ({
  e2e,
}) => {
  await e2e.extension.writeTrustedStorage(completedSettings(false));
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(page);
  await e2e.extension.invokePackagedReader(page);
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());

  const chats = chatRequests(e2e.ollama.requests);
  expect(chats).toHaveLength(1);
  const prompt = userPrompt(chats[0]?.body);
  const selected = taggedSection(prompt, "selected_text");

  expect(selected).toContain("converts light");
  expect(selected).toContain("into chemical energy");
  expect(selected).not.toContain("Photosynthesis");
  expect(prompt).toContain('<nearby_context included="false"></nearby_context>');
  expect(prompt).not.toContain("chlorophyll");
  expect(prompt).not.toContain("glucose");
});

test("limits opted-in nearby context to the nearest visible reading blocks", async ({
  e2e,
}) => {
  await e2e.extension.writeTrustedStorage(completedSettings(true));
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(page);
  await e2e.extension.invokePackagedReader(page);
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());

  const chats = chatRequests(e2e.ollama.requests);
  expect(chats).toHaveLength(1);
  const prompt = userPrompt(chats[0]?.body);
  const context = taggedSection(prompt, "nearby_context");

  expect(prompt).toContain('<nearby_context included="true">');
  expect(context).toContain("chlorophyll");
  expect(context).toContain("glucose");
  expect(context).toContain("Photosynthesis");
  expect(context).not.toContain("converts light");
});

test("never sends hidden, form, script, navigation, or distant page text", async ({
  e2e,
}) => {
  await e2e.extension.writeTrustedStorage(completedSettings(true));
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(page);
  await e2e.extension.invokePackagedReader(page);
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());

  const recorded = JSON.stringify(e2e.ollama.requests);
  for (const marker of FORBIDDEN_SOURCE_MARKERS) {
    expect(recorded).not.toContain(marker);
  }
});

test("renders hostile model markup as inert text without mounting scripts or links", async ({
  e2e,
}) => {
  await e2e.extension.writeTrustedStorage(completedSettings(false));
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(page);
  e2e.ollama.setScenario({ chat: "hostile-markup" });
  await e2e.extension.invokePackagedReader(page);
  await expect(page.getByRole("article", { name: "Local explanation" })).toContainText(
    "Model link",
  );

  const surface = await page.locator("explain-this-reader").evaluate((host) => {
    const root = host.shadowRoot;
    if (!root) throw new Error("The reader shadow root is unavailable.");
    return {
      scripts: root.querySelectorAll("script").length,
      anchors: root.querySelectorAll("a").length,
      images: root.querySelectorAll("img").length,
      inertLinkText: [...root.querySelectorAll(".reader-markdown-link-text")].map(
        (node) => node.textContent,
      ),
    };
  });

  expect(surface.scripts).toBe(0);
  expect(surface.anchors).toBe(0);
  expect(surface.images).toBe(0);
  expect(surface.inertLinkText).toContain("Model link");

  const pageState = await page.evaluate(() => ({
    injectedScripts: [...document.querySelectorAll("script")].filter((script) =>
      script.textContent?.includes("MODEL_SCRIPT"),
    ).length,
    attackerLinks: document.querySelectorAll('a[href*="attacker.example"]').length,
  }));
  expect(pageState.injectedScripts).toBe(0);
  expect(pageState.attackerLinks).toBe(0);
});

test("keeps page source and model output out of local storage and diagnostics", async ({
  e2e,
}) => {
  await e2e.extension.writeTrustedStorage(completedSettings(true));
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));

  await selectNestedPassage(page);
  await e2e.extension.invokePackagedReader(page);
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());

  const local = await e2e.extension.readTrustedStorage();
  expect(Object.keys(local)).toEqual(["settings"]);
  const serializedLocal = JSON.stringify(local);
  for (const marker of [
    "converts light",
    "chemical energy",
    "Local answer",
    "glucose",
  ]) {
    expect(serializedLocal).not.toContain(marker);
  }

  const options = await e2e.extension.openOptions();
  await options.bringToFront();
  await expect(
    options.getByRole("heading", { name: "Explanation settings" }),
  ).toBeVisible();
  await options.evaluate(() => {
    const observed = window as unknown as { copiedDiagnostics?: string };
    delete observed.copiedDiagnostics;
    navigator.clipboard.writeText = async (text: string) => {
      observed.copiedDiagnostics = text;
    };
  });

  await options.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(options.getByRole("status")).toHaveText("Diagnostics copied.");
  const report = await options.evaluate(
    () => (window as unknown as { copiedDiagnostics?: string }).copiedDiagnostics ?? "",
  );

  expect(report).toContain('"endpoint"');
  expect(report).toContain(JSON.stringify(RECOMMENDED_MODEL));
  for (const marker of [
    "converts light",
    "chemical energy",
    "Local answer",
    "glucose",
    ...FORBIDDEN_SOURCE_MARKERS,
  ]) {
    expect(report).not.toContain(marker);
  }
});
