import type { Page } from "@playwright/test";
import { RECOMMENDED_MODEL } from "../../src/shared/constants";
import { expect, test } from "./e2e-fixture";

/**
 * Temporary capture harness for docs/assets. Runs the packaged extension against the fake
 * Ollama server and synthetic fixture pages, so the screenshots contain no personal data.
 */
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

/**
 * The privacy fixture is deliberately full of test scaffolding ("Secret value", injection
 * bait), which reads badly in documentation. Replace it with clean synthetic article text
 * before capturing; the extension, the selection and the streamed answer stay real.
 */
async function renderArticle(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("nav, form, aside")) node.remove();
    const main = document.querySelector("main");
    if (!main) throw new Error("Fixture main element unavailable.");
    main.innerHTML = [
      '<h1 style="font-size:30px;margin:0 0 18px">How leaves make food</h1>',
      "<p>Every green plant runs on light. The machinery is small enough to sit inside a single cell, and it has been refined for well over a billion years.</p>",
      '<p>Photosynthesis is the process by which <span id="doc-selection">chlorophyll captures light energy and drives a reaction that converts carbon dioxide and water into sugar</span>, which the plant then stores as fuel.</p>',
      "<p>The oxygen we breathe is a by-product of that reaction, released through pores on the underside of the leaf.</p>",
    ].join("");
  });
}

async function selectPassage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const text = document.getElementById("doc-selection")?.firstChild;
    if (!text) throw new Error("Documentation selection unavailable.");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

// Documentation capture only. Skipped by default so it never runs in CI or dirties the
// working tree; run it deliberately with CAPTURE_ASSETS=1.
test.skip(
  process.env.CAPTURE_ASSETS !== "1",
  "Set CAPTURE_ASSETS=1 to regenerate docs/assets screenshots.",
);

test("captures the reader card, side panel and onboarding", async ({ e2e }) => {
  await e2e.reset();
  await e2e.extension.writeTrustedStorage(completedSettings);

  const page = await e2e.extension.openFixture(e2e.fixturePages.url("normal.html"));
  await renderArticle(page);
  await selectPassage(page);
  await e2e.extension.invokePackagedReader(page);
  // The fake server holds the chat stream until it is explicitly released, exactly as
  // the reader specs do; without this the e2e idle budget ends the stream early.
  const card = page.getByRole("article", { name: "Local explanation" });
  await expect(card).toContainText("Local");
  e2e.ollama.releaseChat();
  await expect(card).toContainText("Local answer.");
  await page.screenshot({ path: "docs/assets/selection-card.png" });

  await page.getByRole("button", { name: "Open in side panel" }).click();
  const panel = await e2e.extension.openSidePanel(page);
  await panel.setViewportSize({ width: 480, height: 800 });
  await expect(panel.getByRole("heading", { name: "Explain This" })).toBeVisible();
  await panel.screenshot({ path: "docs/assets/side-panel.png" });

  await e2e.reset();
  const options = await e2e.extension.openOptions();
  await options.setViewportSize({ width: 1100, height: 850 });
  await options.bringToFront();
  await options.getByRole("button", { name: "Start local setup" }).click();
  await expect(
    options.getByRole("heading", { name: "Choose a local model" }),
  ).toBeVisible();
  // The step frame fades in. Disabling animations froze it at opacity 0, so instead wait
  // until nothing in the button ancestry is still mid-transition.
  await options.waitForFunction((label) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) return false;
    let node: HTMLElement | null = button;
    while (node) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
      node = node.parentElement;
    }
    return true;
  }, `Use ${RECOMMENDED_MODEL}`);
  await options.screenshot({ path: "docs/assets/onboarding.png" });
});
