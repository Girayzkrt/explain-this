/**
 * Single source of truth for every public error code. Every schema and lookup
 * table that needs to accept, validate, or enumerate these codes must derive
 * from this constant instead of hand-maintaining its own literal list — a
 * hand-maintained copy silently drifts out of sync when a new code is added
 * here, and TypeScript's `satisfies` does not catch a copy that is missing
 * members (only ones that have extra, invalid members).
 */
export const PUBLIC_ERROR_CODES = [
  "OLLAMA_UNREACHABLE",
  "OLLAMA_ORIGIN_BLOCKED",
  "OLLAMA_SIGNIN_REQUIRED",
  "NO_MODEL",
  "MODEL_NOT_FOUND",
  "CLOUD_MODEL_IN_LOCAL_MODE",
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
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export class PublicError extends Error {
  constructor(
    public readonly code: PublicErrorCode,
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "PublicError";
  }
}
