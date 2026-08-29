import { PublicError } from "../../core/requests/public-error";

const INVALID_ENDPOINT_MESSAGE = "The Ollama address is not allowed.";
const EXACT_OLLAMA_BASE = /^http:\/\/(?:127\.0\.0\.1|localhost):11434\/?$/;

/** Restrict model traffic to Ollama's exact, uncredentialed HTTP loopback base. */
export function normalizeOllamaBaseUrl(input: string): URL {
  if (!EXACT_OLLAMA_BASE.test(input)) {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }

  const allowedHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "11434" ||
    !allowedHost ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PublicError("INVALID_ENDPOINT", INVALID_ENDPOINT_MESSAGE, false);
  }

  return url;
}
