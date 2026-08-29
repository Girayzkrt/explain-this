import { PublicError } from "../../core/requests/public-error";

const INVALID_ENDPOINT_MESSAGE = "The Ollama address is not allowed.";

/** Restrict model traffic to Ollama's exact, uncredentialed HTTP loopback base. */
export function normalizeOllamaBaseUrl(input: string): URL {
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
