import { RECOMMENDED_MODEL } from "../../src/shared/constants";
import { beginLocalSetup, expect, test } from "./e2e-fixture";

test.beforeEach(async ({ e2e }) => {
  await e2e.reset();
});

test("shows a recoverable missing-runtime state without persisting page data", async ({
  e2e,
}) => {
  e2e.ollama.setScenario({ tags: "http-failure" });
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await beginLocalSetup(options);

  await expect(
    options.getByRole("heading", { name: "Ollama isn’t available" }),
  ).toBeVisible();
  await expect(options.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(e2e.extension.readTrustedStorage()).resolves.toEqual({
    settings: {
      onboardingVersion: 0,
      preferences: {
        preferredLanguage: "en-US",
        explanationLevel: "everyday",
        preserveEnglishTerms: true,
        includeNearbyContext: false,
        selectedProvider: "ollama-local",
        selectedModel: RECOMMENDED_MODEL,
        automaticToolbar: false,
        blockedSites: [],
      },
    },
  });
});

test("downloads the recommended model after confirmation and finishes with denied page access", async ({
  e2e,
}) => {
  e2e.ollama.setScenario({ tags: "no-model" });
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await beginLocalSetup(options);
  await expect
    .poll(() => e2e.ollama.requests.map(({ method, path }) => `${method} ${path}`), {
      timeout: 10_000,
    })
    .toContain("GET /api/tags");
  await expect(
    options.getByRole("heading", { name: "Choose a local model" }),
  ).toBeVisible();
  await expect(
    options.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }),
  ).toBeVisible();

  await options.getByRole("button", { name: `Download ${RECOMMENDED_MODEL}` }).click();
  await e2e.ollama.waitForRequest((request) => request.path === "/api/pull");
  await expect(
    options.getByRole("heading", { name: "Downloading the local model" }),
  ).toBeVisible();
  await expect(
    options.getByRole("progressbar", { name: "Model download" }),
  ).toHaveAttribute("value", "25");
  e2e.ollama.releasePull();
  await expect(
    options.getByRole("heading", { name: "Choose how explanations read" }),
  ).toBeVisible();

  // Level, language, nearby context and page access are one screen now.
  await options.getByRole("radio", { name: /Technical:/ }).check();
  await expect(
    options.getByRole("checkbox", { name: /Include nearby context/ }),
  ).not.toBeChecked();
  await expect(
    options.getByRole("checkbox", { name: /Show the selection toolbar/ }),
  ).not.toBeChecked();
  await options.getByRole("button", { name: "Confirm and continue" }).click();
  await e2e.ollama.waitForRequest((request) => request.path === "/api/chat");
  e2e.ollama.releaseChat();
  await expect(options.getByRole("heading", { name: "Ready" })).toBeVisible();
  await expect(options.getByText("Your local model is ready.")).toBeVisible();

  await options.getByRole("button", { name: "Finish setup" }).click();
  await expect(
    options.getByRole("heading", { name: "Explanation settings" }),
  ).toBeVisible();

  const local = await e2e.extension.readTrustedStorage();
  expect(Object.keys(local)).toEqual(["settings"]);
  expect(local).toEqual({
    settings: {
      onboardingVersion: 1,
      preferences: {
        preferredLanguage: "en-US",
        explanationLevel: "technical",
        preserveEnglishTerms: true,
        includeNearbyContext: false,
        selectedProvider: "ollama-local",
        selectedModel: RECOMMENDED_MODEL,
        automaticToolbar: false,
        blockedSites: [],
      },
    },
  });
  expect(JSON.stringify(local)).not.toMatch(/Photosynthesis|Local answer/);
});

test("keeps onboarding complete when a usable model only meets the readiness warning threshold", async ({
  e2e,
}) => {
  const options = await e2e.extension.openOptions();
  await options.bringToFront();

  await beginLocalSetup(options);
  await expect(
    options.getByRole("heading", { name: "Choose a local model" }),
  ).toBeVisible();
  await options.getByRole("button", { name: `Use ${RECOMMENDED_MODEL}` }).click();
  await options.getByRole("radio", { name: /Everyday:/ }).check();

  e2e.ollama.setScenario({ chat: "slow-generation" });
  await options.getByRole("button", { name: "Confirm and continue" }).click();
  await expect(
    options.getByRole("heading", { name: "Testing your local model" }),
  ).toBeVisible();
  await e2e.ollama.waitForRequest((request) => request.path === "/api/chat");
  e2e.ollama.releaseChat();

  await expect(options.getByRole("heading", { name: "Ready" })).toBeVisible();
  await expect(options.getByRole("status")).toContainText(
    "Your model is ready, but slower than recommended.",
  );
});
