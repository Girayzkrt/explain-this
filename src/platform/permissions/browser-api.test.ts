import { describe, expect, it, vi } from "vitest";

const executeScript = vi.fn(function (this: unknown) {
  if (this !== scripting) throw new TypeError("Incorrect scripting receiver.");
  return Promise.resolve();
});

const scripting = { executeScript };

vi.mock("wxt/browser", () => ({
  browser: { scripting },
}));

describe("reader browser API", () => {
  it("calls scripting.executeScript with the browser receiver", async () => {
    const { readerBrowserApi } = await import("./browser-api");

    await expect(readerBrowserApi.executeReader(42)).resolves.toBeUndefined();
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["content-scripts/reader.js"],
      world: "ISOLATED",
    });
  });
});
