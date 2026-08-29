import { describe, expect, it } from "vitest";
import { enforceReadingBudget } from "./budget";

describe("reading budget", () => {
  it("accepts a bounded Latin selection and optional context", () => {
    const input = {
      selection: "Concurrency lets multiple tasks make progress.",
      nearbyContext: "This paragraph introduces scheduling.",
      previousAnswer: undefined,
    };

    expect(enforceReadingBudget(input)).toEqual(input);
  });

  it("rejects dense-script text over the selected-text budget", () => {
    const selection = "漢".repeat(1601);
    expect(() =>
      enforceReadingBudget({
        selection,
        nearbyContext: undefined,
        previousAnswer: undefined,
      }),
    ).toThrowError(/SELECTION_TOO_LARGE/);
  });

  it("never silently truncates oversized nearby context", () => {
    expect(() =>
      enforceReadingBudget({
        selection: "A short selection",
        nearbyContext: "語".repeat(401),
        previousAnswer: undefined,
      }),
    ).toThrowError(/CONTEXT_TOO_LARGE/);
  });
});
