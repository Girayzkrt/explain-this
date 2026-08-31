import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../../features/settings/settings";
import {
  createReaderRuntimeHandler,
  parseReaderRuntimeMessage,
} from "./reader-runtime";

describe("reader runtime boundary", () => {
  it("accepts only the two data-free reader runtime commands", () => {
    expect(parseReaderRuntimeMessage({ type: "get-reader-config" })).toEqual({
      type: "get-reader-config",
    });
    expect(parseReaderRuntimeMessage({ type: "open-side-panel" })).toEqual({
      type: "open-side-panel",
    });
    expect(() =>
      parseReaderRuntimeMessage({
        type: "get-reader-config",
        prompt: "leak settings",
      }),
    ).toThrow();
    expect(() =>
      parseReaderRuntimeMessage({ type: "open-side-panel", tabId: 9 }),
    ).toThrow();
  });

  it("returns only needed booleans to a trusted HTTP page sender", async () => {
    const opened: number[] = [];
    const handler = createReaderRuntimeHandler({
      extensionId: "extension-id",
      settingsRepository: {
        async get() {
          return {
            onboardingVersion: 1,
            preferences: {
              ...DEFAULT_PREFERENCES,
              automaticToolbar: true,
              includeNearbyContext: true,
              blockedSites: ["blocked.example"],
              preferredLanguage: "Secret preference",
              selectedModel: "secret-model",
            },
          };
        },
      },
      async openSidePanel(tabId) {
        opened.push(tabId);
      },
    });

    const response = await handler(
      { type: "get-reader-config" },
      {
        id: "extension-id",
        tab: { id: 7, url: "https://sub.blocked.example/article" },
      },
    );

    expect(response).toEqual({
      automaticToolbar: true,
      includeNearbyContext: true,
      blocked: true,
    });
    expect(JSON.stringify(response)).not.toMatch(
      /secret|prompt|source|endpoint|model/i,
    );
    await handler(
      { type: "open-side-panel" },
      {
        id: "extension-id",
        tab: { id: 7, url: "https://reader.example/article" },
      },
    );
    expect(opened).toEqual([7]);
  });

  it.each([
    { id: "other-extension", tab: { id: 7, url: "https://reader.example" } },
    { id: "extension-id", tab: { url: "https://reader.example" } },
    { id: "extension-id", tab: { id: 7, url: "chrome://settings" } },
  ])("rejects an untrusted sender %#", async (sender) => {
    const handler = createReaderRuntimeHandler({
      extensionId: "extension-id",
      settingsRepository: {
        async get() {
          return { onboardingVersion: 1, preferences: DEFAULT_PREFERENCES };
        },
      },
      async openSidePanel() {},
    });
    await expect(handler({ type: "get-reader-config" }, sender)).rejects.toThrow();
  });
});
