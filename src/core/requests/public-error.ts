export type PublicErrorCode =
  | "OLLAMA_UNREACHABLE"
  | "OLLAMA_ORIGIN_BLOCKED"
  | "NO_MODEL"
  | "MODEL_NOT_FOUND"
  | "CLOUD_MODEL_IN_LOCAL_MODE"
  | "MODEL_DOWNLOAD_FAILED"
  | "CONNECTION_TIMEOUT"
  | "FIRST_TOKEN_TIMEOUT"
  | "STREAM_IDLE_TIMEOUT"
  | "MALFORMED_STREAM"
  | "UNSUPPORTED_PAGE"
  | "PAGE_PERMISSION_DENIED"
  | "EMPTY_SELECTION"
  | "SELECTION_TOO_LARGE"
  | "CONTEXT_TOO_LARGE"
  | "REQUEST_CANCELLED"
  | "PROVIDER_ERROR"
  | "INVALID_REQUEST"
  | "INVALID_ENDPOINT";

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
