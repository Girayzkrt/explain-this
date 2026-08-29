import { describe, expect, it } from "vitest";
import { PublicError } from "./public-error";
import { validateReadingRequest } from "./schemas";

const validPreferences = {
  preferredLanguage: "English",
  explanationLevel: "everyday",
  preserveEnglishTerms: true,
  includeNearbyContext: false,
  selectedProvider: "ollama",
  selectedModel: "llama3.2",
  automaticToolbar: false,
  blockedSites: [],
};

const validRequest = {
  requestId: "7b1cba4e-88d6-4a20-88f9-cf93ce3e09bf",
  action: "explain",
  selection: "A concurrent program can make progress on several tasks.",
  preferences: validPreferences,
};

describe("reading request schema", () => {
  it.each(["explain", "simplify", "translate", "example"] as const)(
    "accepts the %s action",
    (action) => {
      expect(validateReadingRequest({ ...validRequest, action }).action).toBe(action);
    },
  );

  it("rejects an unknown action", () => {
    expect(() =>
      validateReadingRequest({ ...validRequest, action: "summarize" }),
    ).toThrow(PublicError);
  });

  it("rejects an empty selection", () => {
    expect(() =>
      validateReadingRequest({ ...validRequest, selection: "" }),
    ).toThrow(PublicError);
  });

  it("rejects arbitrary request properties", () => {
    expect(() =>
      validateReadingRequest({ ...validRequest, providerEndpoint: "https://example.test" }),
    ).toThrow(PublicError);
  });

  it("accepts only approved preference enum values", () => {
    expect(() =>
      validateReadingRequest({
        ...validRequest,
        preferences: { ...validPreferences, explanationLevel: "expert" },
      }),
    ).toThrow(PublicError);
  });

  it("rejects nearby context when the preference is disabled", () => {
    expect(() =>
      validateReadingRequest({
        ...validRequest,
        nearbyContext: "The prior paragraph defines concurrent work.",
      }),
    ).toThrow(PublicError);
  });

  it("accepts nearby context when the preference is enabled", () => {
    expect(
      validateReadingRequest({
        ...validRequest,
        nearbyContext: "The prior paragraph defines concurrent work.",
        preferences: { ...validPreferences, includeNearbyContext: true },
      }).nearbyContext,
    ).toBe("The prior paragraph defines concurrent work.");
  });

  it("requires a follow-up intent and previous answer together", () => {
    expect(() =>
      validateReadingRequest({ ...validRequest, followUpIntent: "why" }),
    ).toThrow(PublicError);
    expect(() =>
      validateReadingRequest({ ...validRequest, previousAnswer: "Because tasks share time." }),
    ).toThrow(PublicError);
  });
});
