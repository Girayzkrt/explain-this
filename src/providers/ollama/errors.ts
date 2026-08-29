import { PublicError } from "../../core/requests/public-error";
import type { PublicErrorShape } from "../provider";

export function mapOllamaResponseError(
  response: Response,
  operation: "request" | "download" = "request",
): PublicError {
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
