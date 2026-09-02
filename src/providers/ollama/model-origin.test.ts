import { describe, expect, test } from "vitest";
import { deriveModelOrigin } from "./model-origin";

describe("deriveModelOrigin", () => {
  test("treats a -cloud suffix as cloud whatever the size says", () => {
    expect(deriveModelOrigin("gpt-oss:120b-cloud", 0)).toBe("cloud");
    expect(deriveModelOrigin("gemma4:26b-cloud", 4_000_000_000)).toBe("cloud");
  });

  test("treats a named model with real local weights as local", () => {
    expect(deriveModelOrigin("gemma3:4b", 3_338_801_804)).toBe("local");
  });

  // Ollama's API carries no cloud marker, so a model with no weights on disk and no
  // suffix cannot be classified. It must not be assumed local.
  test("reports an unmarked model with no local weights as unknown", () => {
    expect(deriveModelOrigin("mistral-large-3", 0)).toBe("unknown");
    expect(deriveModelOrigin("mistral-large-3", undefined)).toBe("unknown");
  });
});
