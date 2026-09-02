// @vitest-environment node

import { describe, expect, it } from "vitest";
import { closeE2eResources } from "../e2e/e2e-fixture";

describe("e2e fixture cleanup", () => {
  it("attempts every cleanup and reports their failures together", async () => {
    const calls: string[] = [];
    const extensionFailure = new Error("extension close failed");
    const fixtureFailure = new Error("fixture server close failed");
    const ollamaFailure = new Error("Ollama server close failed");

    await expect(
      closeE2eResources({
        extension: {
          close: async () => {
            calls.push("extension");
            throw extensionFailure;
          },
        },
        fixturePages: {
          close: async () => {
            calls.push("fixture");
            throw fixtureFailure;
          },
        },
        ollama: {
          close: async () => {
            calls.push("ollama");
            throw ollamaFailure;
          },
        },
      }),
    ).rejects.toMatchObject({
      errors: [extensionFailure, fixtureFailure, ollamaFailure],
    });

    expect(calls).toEqual(["extension", "fixture", "ollama"]);
  });
});
