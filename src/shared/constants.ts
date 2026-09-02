export const OLLAMA_BASE_URL =
  typeof __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__ === "undefined"
    ? "http://127.0.0.1:11434"
    : __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__;
/** Shortened stream timeouts exist only in an e2e package; production keeps provider defaults. */
export const E2E_STREAM_TIMEOUT_MS =
  typeof __EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__ === "undefined"
    ? undefined
    : __EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__;
export const RECOMMENDED_MODEL = "gemma3:4b";
export const ONBOARDING_VERSION = 1;
