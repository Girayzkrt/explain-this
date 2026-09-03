import { describe, expect, test } from "vitest";
import { mapOllamaResponseError } from "./errors";

function response(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("mapOllamaResponseError", () => {
  // Observed on a real installation: with OLLAMA_NO_CLOUD set, /api/show for a cloud
  // model answers 403 with this body. Read as an origin rejection it sends the reader
  // to edit OLLAMA_ORIGINS, which cannot fix it.
  test("reads a disabled cloud out of a 403 rather than blaming the origin", async () => {
    const error = await mapOllamaResponseError(
      response(
        403,
        '{"error":"ollama cloud is disabled: remote model details are unavailable"}',
      ),
    );

    expect(error.code).toBe("OLLAMA_CLOUD_DISABLED");
    expect(error.recoverable).toBe(true);
  });

  test("still treats any other 403 as an origin rejection", async () => {
    const error = await mapOllamaResponseError(response(403, "Forbidden"));

    expect(error.code).toBe("OLLAMA_ORIGIN_BLOCKED");
  });

  // A body that cannot be read must not lose the error entirely; the common case wins.
  test("falls back to an origin rejection when the body is unreadable", async () => {
    const unreadable = {
      status: 403,
      text: () => Promise.reject(new Error("stream already consumed")),
    } as unknown as Response;

    const error = await mapOllamaResponseError(unreadable);

    expect(error.code).toBe("OLLAMA_ORIGIN_BLOCKED");
  });

  test("maps 401 to the sign-in prompt", async () => {
    const error = await mapOllamaResponseError(response(401, "Unauthorized"));

    expect(error.code).toBe("OLLAMA_SIGNIN_REQUIRED");
  });

  test("maps 404 to a missing model", async () => {
    const error = await mapOllamaResponseError(response(404, "not found"));

    expect(error.code).toBe("MODEL_NOT_FOUND");
  });
});
