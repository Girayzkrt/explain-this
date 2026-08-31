import { describe, expect, it } from "vitest";
import type { PublicErrorCode } from "./public-error";
import { ERROR_PRESENTATIONS } from "./error-copy";

const publicErrorCodes: readonly PublicErrorCode[] = [
  "OLLAMA_UNREACHABLE",
  "OLLAMA_ORIGIN_BLOCKED",
  "NO_MODEL",
  "MODEL_NOT_FOUND",
  "MODEL_DOWNLOAD_FAILED",
  "CONNECTION_TIMEOUT",
  "FIRST_TOKEN_TIMEOUT",
  "STREAM_IDLE_TIMEOUT",
  "MALFORMED_STREAM",
  "UNSUPPORTED_PAGE",
  "PAGE_PERMISSION_DENIED",
  "EMPTY_SELECTION",
  "SELECTION_TOO_LARGE",
  "CONTEXT_TOO_LARGE",
  "REQUEST_CANCELLED",
  "PROVIDER_ERROR",
  "INVALID_REQUEST",
  "INVALID_ENDPOINT",
];

describe("public error presentations", () => {
  it.each(publicErrorCodes)("provides fixed recovery copy for %s", (code) => {
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
