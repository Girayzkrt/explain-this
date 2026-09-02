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
      selectedModel: "gemma3:4b",
      automaticToolbar: false,
      blockedSites: [],
    });
    expect(createDefaultModelProfile()).toEqual({
      model: "gemma3:4b",
      numCtx: 4096,
      think: false,
      keepAlive: "5m",
      maxConcurrentRequests: 1,
    });
  });
});
