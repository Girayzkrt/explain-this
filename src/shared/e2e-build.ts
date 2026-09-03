export const E2E_OLLAMA_BASE_URL = "VITE_EXPLAIN_THIS_OLLAMA_BASE_URL";
export const E2E_FIXTURE_ORIGIN = "VITE_EXPLAIN_THIS_FIXTURE_ORIGIN";

export interface E2eBuildEndpoints {
  ollamaOrigin: string;
  fixtureOrigin: string;
}

type Environment = Record<string, string | undefined>;

function exactLoopbackOrigin(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`E2E ${name} is required.`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`E2E ${name} must be an exact IPv4 loopback origin.`);
  }

  const port = Number(url.port);
  if (
    value !== `http://127.0.0.1:${url.port}` ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`E2E ${name} must be an exact IPv4 loopback origin.`);
  }

  return value;
}

/** Validate build-only local endpoints before WXT emits test permissions. */
export function parseE2eBuildEndpoints(
  environment: Environment = process.env,
): E2eBuildEndpoints {
  const ollamaOrigin = exactLoopbackOrigin(
    environment[E2E_OLLAMA_BASE_URL],
    E2E_OLLAMA_BASE_URL,
  );
  const fixtureOrigin = exactLoopbackOrigin(
    environment[E2E_FIXTURE_ORIGIN],
    E2E_FIXTURE_ORIGIN,
  );
  if (ollamaOrigin === fixtureOrigin) {
    throw new Error("E2E Ollama and fixture origins must use distinct ports.");
  }
  return { ollamaOrigin, fixtureOrigin };
}
