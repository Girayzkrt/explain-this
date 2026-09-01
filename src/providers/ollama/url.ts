import { PublicError } from "../../core/requests/public-error";

const INVALID_ENDPOINT_MESSAGE = "The Ollama address is not allowed.";
const EXACT_OLLAMA_BASE = /^http:\/\/(?:127\.0\.0\.1|localhost):11434\/?$/;

const e2eOllamaBaseUrl =
  typeof __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__ === "undefined"
    ? undefined
    : __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__;

function isAllowedBase(input: string): boolean {
  return EXACT_OLLAMA_BASE.test(input) || input === e2eOllamaBaseUrl;
}

/** Restrict model traffic to Ollama's exact, uncredentialed HTTP loopback base. */
export function normalizeOllamaBaseUrl(input: string): URL {
  if (!isAllowedBase(input)) {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }

  const isProductionBase = EXACT_OLLAMA_BASE.test(input);
  if (!isProductionBase && e2eOllamaBaseUrl === undefined) {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }
  const allowedHost = isProductionBase
    ? url.hostname === "127.0.0.1" || url.hostname === "localhost"
    : url.hostname === "127.0.0.1";
  const allowedPort = isProductionBase ? "11434" : new URL(e2eOllamaBaseUrl!).port;
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== allowedPort ||
    !allowedHost ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }

  return url;
}
