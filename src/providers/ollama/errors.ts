import { PublicError } from "../../core/requests/public-error";
import type { PublicErrorShape } from "../provider";

export function mapOllamaResponseError(
  response: Response,
  operation: "request" | "download" = "request",
): PublicError {
  // 401 is the observed shape for an expired or missing Ollama Cloud session. 403 is
  // left mapped to OLLAMA_ORIGIN_BLOCKED below and deliberately not folded in here:
  // origin-blocking is real and common in local mode too, and the spec calls for
  // narrowing this mapping only once the real unauthenticated response shape has been
  // observed against a signed-in installation — which 401 now is.
  if (response.status === 401) {
    return new PublicError(
      "OLLAMA_SIGNIN_REQUIRED",
      "Ollama Cloud requires signing in.",
      true,
    );
  }
  if (response.status === 403) {
    return new PublicError(
      "OLLAMA_ORIGIN_BLOCKED",
      "Ollama blocked the extension origin.",
      true,
    );
  }
  if (response.status === 404) {
    return new PublicError(
      "MODEL_NOT_FOUND",
      "The selected model was not found.",
      true,
    );
  }
  if (operation === "download") {
    return new PublicError(
      "MODEL_DOWNLOAD_FAILED",
      "Ollama could not download the model.",
      true,
    );
  }
  return new PublicError(
    "PROVIDER_ERROR",
    "Ollama could not complete the request.",
    true,
  );
}

export function mapOllamaFailure(error: unknown, signal: AbortSignal): PublicError {
  if (error instanceof PublicError) return error;
  if (signal.aborted && signal.reason instanceof PublicError) return signal.reason;
  if (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return new PublicError("REQUEST_CANCELLED", "The request was cancelled.", true);
  }
  if (error instanceof TypeError) {
    return new PublicError("OLLAMA_UNREACHABLE", "Ollama is not reachable.", true);
  }
  return new PublicError(
    "PROVIDER_ERROR",
    "Ollama could not complete the request.",
    true,
  );
}

export function toPublicErrorShape(error: PublicError): PublicErrorShape {
  return {
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
  };
}
