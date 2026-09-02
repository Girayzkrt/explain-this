import { describe, expect, it } from "vitest";
import {
  createDefaultModelProfile,
  createDefaultPreferences,
  ReadingPreferencesSchema,
} from "./settings";

describe("reading settings", () => {
  it("creates the approved privacy and model defaults", () => {
    expect(ReadingPreferencesSchema.parse(createDefaultPreferences())).toEqual({
      preferredLanguage: "English",
      explanationLevel: "everyday",
      preserveEnglishTerms: true,
      includeNearbyContext: false,
      selectedProvider: "ollama",
      selectedModel: "qwen2.5:3b-instruct",
      automaticToolbar: false,
      blockedSites: [],
    });
    expect(createDefaultModelProfile()).toEqual({
      model: "qwen2.5:3b-instruct",
      numCtx: 4096,
      think: false,
      keepAlive: "5m",
      maxConcurrentRequests: 1,
    });
  });
});
