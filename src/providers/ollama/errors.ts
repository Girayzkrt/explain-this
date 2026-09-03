import { PublicError } from "../../core/requests/public-error";
import type { PublicErrorShape } from "../provider";

/** Long enough for Ollama’s one-line error JSON, short enough to never be a buffer. */
const ERROR_BODY_LIMIT = 512;
/** An error body is a courtesy. A stalled one must never outlive the error it explains. */
const ERROR_BODY_TIMEOUT_MS = 200;

/**
 * Reads just enough of an error body to classify it, then always cancels the stream.
 * Ollama can answer with a body that never arrives, so an unbounded read here would
 * hang the request forever in place of reporting the error it was called to describe.
 */
async function readErrorBody(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ERROR_BODY_TIMEOUT_MS);
      }),
    ]);
    if (!chunk || chunk.done || !chunk.value) return "";
    return new TextDecoder().decode(chunk.value).slice(0, ERROR_BODY_LIMIT);
  } catch {
    return "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

/** Ollama says this, verbatim, when a cloud model is used while cloud is switched off. */
const CLOUD_DISABLED = /cloud is disabled/iu;

export async function mapOllamaResponseError(
  response: Response,
  operation: "request" | "download" = "request",
): Promise<PublicError> {
  // 401 is the observed shape for an expired or missing Ollama Cloud session.
  if (response.status === 401) {
    return new PublicError(
      "OLLAMA_SIGNIN_REQUIRED",
      "Ollama Cloud requires signing in.",
      true,
    );
  }
  if (response.status === 403) {
    // Both an origin rejection and a disabled-cloud refusal arrive as 403, and they
    // need opposite advice: one is fixed in OLLAMA_ORIGINS, the other by turning cloud
    // on or choosing a model that runs here. Only the body tells them apart.
    if (CLOUD_DISABLED.test(await readErrorBody(response))) {
      return new PublicError(
        "OLLAMA_CLOUD_DISABLED",
        "Ollama Cloud is turned off in Ollama.",
        true,
      );
    }
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
