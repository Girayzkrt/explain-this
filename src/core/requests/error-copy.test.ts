import { describe, expect, it } from "vitest";
import { PUBLIC_ERROR_CODES } from "./public-error";
import { ERROR_PRESENTATIONS } from "./error-copy";

describe("public error presentations", () => {
  it.each(PUBLIC_ERROR_CODES)("provides fixed recovery copy for %s", (code) => {
    const presentation = ERROR_PRESENTATIONS[code];

    expect(presentation.title).toMatch(/\S/);
    expect(presentation.explanation).toMatch(/\S/);
    expect(presentation.primaryAction.label).toMatch(/\S/);
    expect(presentation.primaryAction.intent).toMatch(
      /^(retry|open-setup|choose-model|show-origin-steps|select-less-text|continue-without-access|dismiss)$/,
    );
  });

  it("keeps distinct recovery decisions for endpoint, origin, model, limits, and cancellation", () => {
    expect(ERROR_PRESENTATIONS.INVALID_ENDPOINT.primaryAction.intent).toBe(
      "open-setup",
    );
    expect(ERROR_PRESENTATIONS.OLLAMA_ORIGIN_BLOCKED.primaryAction.intent).toBe(
      "show-origin-steps",
    );
    expect(ERROR_PRESENTATIONS.NO_MODEL.primaryAction.intent).toBe("choose-model");
    expect(ERROR_PRESENTATIONS.SELECTION_TOO_LARGE.primaryAction.intent).toBe(
      "select-less-text",
    );
    expect(ERROR_PRESENTATIONS.REQUEST_CANCELLED.primaryAction.intent).toBe("dismiss");
  });
});
