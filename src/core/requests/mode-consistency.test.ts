import { describe, expect, test } from "vitest";
import { blocksRequest, checkModeConsistency } from "./mode-consistency";

describe("checkModeConsistency", () => {
  test("accepts a local model in local mode and a cloud model in cloud mode", () => {
    expect(checkModeConsistency("ollama-local", "local")).toBe("ok");
    expect(checkModeConsistency("ollama-cloud", "cloud")).toBe("ok");
  });

  test("refuses a cloud model in local mode", () => {
    expect(checkModeConsistency("ollama-local", "cloud")).toBe(
      "cloud-model-in-local-mode",
    );
  });

  // The heuristic cannot prove this model is local, and local mode has promised the text
  // stays on the machine, so the unprovable case is refused rather than assumed safe.
  test("refuses an unknown origin in local mode", () => {
    expect(checkModeConsistency("ollama-local", "unknown")).toBe(
      "cloud-model-in-local-mode",
    );
  });

  test("reports a local model in cloud mode as a mismatch", () => {
    expect(checkModeConsistency("ollama-cloud", "local")).toBe(
      "local-model-in-cloud-mode",
    );
  });
});

describe("blocksRequest", () => {
  // Only the unsafe direction stops a request. The other gives the reader more privacy
  // than they asked for, which is no reason to refuse to answer.
  test("blocks only the mismatch that would break the privacy promise", () => {
    expect(blocksRequest("cloud-model-in-local-mode")).toBe(true);
    expect(blocksRequest("local-model-in-cloud-mode")).toBe(false);
    expect(blocksRequest("ok")).toBe(false);
  });
});
