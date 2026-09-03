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
      selectedProvider: "ollama-local",
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

/** Select the multilingual fixture's dense-script passage, which sits just over budget. */
async function selectOversizedPassage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const text = document.getElementById("oversized-selection")?.firstChild;
    if (!text) throw new Error("Known oversized selection fixture is unavailable.");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
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

// Setup, model, and origin recovery use the trusted options-page route; title and
// explanation together pin the exact PublicErrorCode that reached the shadow UI.
test("reports an unreachable local runtime in the reader card", async ({ e2e }) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setUnreachable(true);
  await e2e.extension.invokePackagedReader(page);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("Model unavailable");
  await expect(notice).toContainText(
    "Explain This could not reach Ollama on this computer.",
  );
  await page.getByRole("button", { name: "Close explanation" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("reports a rejected extension origin in the reader card", async ({ e2e }) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "origin-reject" });
  await e2e.extension.invokePackagedReader(page);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("Ollama needs this extension allowed");
  await expect(notice).toContainText("Ollama rejected the extension’s local request.");
});

test("reports a missing selected model in the reader card", async ({ e2e }) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "missing-model" });
  await e2e.extension.invokePackagedReader(page);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("Selected model is unavailable");
  await expect(notice).toContainText("The selected model is no longer installed.");
});

test("reports a generic provider failure as a retryable error", async ({ e2e }) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "http-failure" });
  await e2e.extension.invokePackagedReader(page);

  await expect(page.getByText("Model could not finish")).toBeVisible();

  e2e.ollama.setScenario({ chat: "normal" });
  await page.getByRole("button", { name: "Try again" }).click();
  await releaseAfterVisibleDelta(page, () => e2e.ollama.releaseChat());
});

test("times out a stream that never produces a first token", async ({ e2e }) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "slow-first-token" });
  await e2e.extension.invokePackagedReader(page);

  await expect(page.getByText("Model took too long to start")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("times out an idle stream while keeping the partial output visible", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "idle-stream" });
  await e2e.extension.invokePackagedReader(page);

  await expect(page.getByText("Explanation timed out")).toBeVisible();
  await expect(page.getByRole("article", { name: "Local explanation" })).toContainText(
    "Partial output",
  );
  await expect(page.getByText("Incomplete output")).toBeVisible();
});

test("surfaces a malformed stream while keeping the partial output visible", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "malformed-partial" });
  await e2e.extension.invokePackagedReader(page);

  await expect(page.getByText("Response could not be read")).toBeVisible();
  await expect(page.getByRole("article", { name: "Local explanation" })).toContainText(
    "Partial output",
  );
});

test("refuses an oversized dense-script selection before contacting the model", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(
    e2e.fixturePages.url("multilingual.html"),
  );
  await selectOversizedPassage(page);

  await e2e.extension.invokePackagedReader(page);

  const notice = page.getByRole("alert");
  await expect(notice).toContainText("Select less text");
  await expect(notice).toContainText(
    "The selected passage is too large for an explanation.",
  );
  expect(e2e.ollama.requests.filter((request) => request.path === "/api/chat")).toEqual(
    [],
  );
});

test("cancels an in-flight generation when the page navigates away", async ({
  e2e,
}) => {
  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await selectNestedPassage(page);

  e2e.ollama.setScenario({ chat: "slow-first-token" });
  await e2e.extension.invokePackagedReader(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect
    .poll(async () => {
      const session = await e2e.extension.readTrustedStorage("session");
      return Object.keys(session).filter(
        (key) => key.startsWith("reader-session:") || key.startsWith("reader-source:"),
      ).length;
    })
    .toBe(2);
  const beforeNavigation = await e2e.extension.readTrustedStorage("session");
  const readerKeys = Object.keys(beforeNavigation).filter(
    (key) => key.startsWith("reader-session:") || key.startsWith("reader-source:"),
  );

  await page.goto(e2e.fixturePages.url("multilingual.html"));
  await e2e.ollama.waitForCancellation("/api/chat");

  await expect(page.locator("explain-this-reader")).toHaveCount(0);
  const session = await e2e.extension.readTrustedStorage("session");
  for (const key of readerKeys) {
    expect(Object.hasOwn(session, key)).toBe(false);
  }
});
