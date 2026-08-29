import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicError } from "../../core/requests/public-error";
import type { ChatRequest } from "../provider";
import { OllamaProvider, createOllamaProvider } from "./ollama-provider";

const encoder = new TextEncoder();

const chatRequest: ChatRequest = {
  model: "qwen3:4b",
  messages: [
    { role: "system", content: "Be clear." },
    { role: "user", content: "Explain this." },
  ],
  numCtx: 4096,
  numPredict: 512,
  temperature: 0.2,
  think: false,
  keepAlive: "5m",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ndjsonResponse(records: unknown[], onCancel?: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const record of records) {
        controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200 });
}

function openNdjsonResponse(records: unknown[], onCancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const record of records) {
        controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
      }
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OllamaProvider", () => {
  it("maps installed Ollama tags to provider-neutral model information", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/api/tags");
      return jsonResponse({
        models: [
          {
            name: "qwen3:4b",
            model: "qwen3:4b",
            modified_at: "2026-08-01T10:00:00Z",
            size: 2_500_000_000,
            digest: "sha256:one",
            details: { family: "qwen3", parameter_size: "4B" },
          },
          {
            name: "gemma3:1b",
            model: "gemma3:1b",
            modified_at: "2026-08-02T10:00:00Z",
            size: 815_000_000,
            digest: "sha256:two",
            details: { family: "gemma3", parameter_size: "1B" },
          },
        ],
      });
    };
    const provider = createOllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    });

    await expect(provider.listModels(new AbortController().signal)).resolves.toEqual([
      { id: "qwen3:4b", displayName: "qwen3:4b", sizeBytes: 2_500_000_000 },
      { id: "gemma3:1b", displayName: "gemma3:1b", sizeBytes: 815_000_000 },
    ]);
  });

  it("reports a healthy Ollama runtime even when no models are installed", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => jsonResponse({ models: [] }),
    });

    await expect(provider.checkHealth(new AbortController().signal)).resolves.toEqual({
      available: true,
    });
  });

  it("maps an origin rejection to a safe OLLAMA_ORIGIN_BLOCKED error", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        new Response("blocked: secret-model-name", { status: 403 }),
    });

    const result = provider.listModels(new AbortController().signal);
    await expect(result).rejects.toMatchObject({
      code: "OLLAMA_ORIGIN_BLOCKED",
      recoverable: true,
    } satisfies Partial<PublicError>);
    await expect(result).rejects.not.toMatchObject({
      message: expect.stringContaining("secret-model-name"),
    });
  });

  it("maps a fetch TypeError to OLLAMA_UNREACHABLE", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch a private host");
      },
    });

    await expect(
      provider.checkHealth(new AbortController().signal),
    ).rejects.toMatchObject({
      code: "OLLAMA_UNREACHABLE",
      recoverable: true,
    } satisfies Partial<PublicError>);
  });

  it("maps a missing chat model to a safe MODEL_NOT_FOUND event", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        new Response('model "private-model" not found', { status: 404 }),
    });

    const events = await collect(
      provider.streamChat("request-404", chatRequest, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "started", requestId: "request-404" },
      {
        type: "failed",
        requestId: "request-404",
        error: expect.objectContaining({ code: "MODEL_NOT_FOUND" }),
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-model");
  });

  it("streams ordered content deltas and completion metrics while ignoring thinking", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        ndjsonResponse([
          {
            model: "qwen3:4b",
            created_at: "2026-08-29T10:00:00Z",
            message: { role: "assistant", content: "Hello", thinking: "secret chain" },
            done: false,
          },
          {
            model: "qwen3:4b",
            created_at: "2026-08-29T10:00:01Z",
            message: { role: "assistant", content: " world", thinking: "more secret" },
            done: false,
          },
          {
            model: "qwen3:4b",
            created_at: "2026-08-29T10:00:02Z",
            message: { role: "assistant", content: "", thinking: "final secret" },
            done: true,
            total_duration: 1_500_000_000,
            prompt_eval_count: 21,
            eval_count: 8,
          },
        ]),
    });

    const events = await collect(
      provider.streamChat("request-1", chatRequest, new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "started", requestId: "request-1" },
      { type: "delta", requestId: "request-1", sequence: 0, text: "Hello" },
      { type: "delta", requestId: "request-1", sequence: 1, text: " world" },
      {
        type: "completed",
        requestId: "request-1",
        metrics: { inputTokens: 21, outputTokens: 8, durationMs: 1500 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("sends approved Ollama chat controls and never sends tools", async () => {
    let actualBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      actualBody = JSON.parse(String(init?.body));
      return ndjsonResponse([
        {
          model: "qwen3:4b",
          created_at: "2026-08-29T10:00:00Z",
          message: { role: "assistant", content: "done", thinking: "" },
          done: true,
          total_duration: 1_000_000,
          prompt_eval_count: 2,
          eval_count: 1,
        },
      ]);
    };
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
    });

    await collect(
      provider.streamChat("request-body", chatRequest, new AbortController().signal),
    );

    expect(actualBody).toEqual({
      model: "qwen3:4b",
      messages: chatRequest.messages,
      stream: true,
      think: false,
      keep_alive: "5m",
      options: { num_ctx: 4096, num_predict: 512, temperature: 0.2 },
    });
    expect(actualBody).not.toHaveProperty("tools");
  });

  it("maps Ollama pull progress and emits final completion only on success", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("http://localhost:11434/api/pull");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "qwen3:4b",
          stream: true,
        });
        return ndjsonResponse([
          { status: "pulling manifest" },
          {
            status: "downloading digest",
            digest: "sha256:abc",
            total: 1000,
            completed: 250,
          },
          {
            status: "downloading digest",
            digest: "sha256:abc",
            total: 1000,
            completed: 1000,
          },
          { status: "success" },
        ]);
      },
    });

    await expect(
      collect(provider.downloadModel("qwen3:4b", new AbortController().signal)),
    ).resolves.toEqual([
      { type: "started", model: "qwen3:4b" },
      { type: "progress", model: "qwen3:4b", completedBytes: 250, totalBytes: 1000 },
      {
        type: "progress",
        model: "qwen3:4b",
        completedBytes: 1000,
        totalBytes: 1000,
      },
      { type: "completed", model: "qwen3:4b" },
    ]);
  });

  it("maps a pull HTTP failure to a safe MODEL_DOWNLOAD_FAILED event", async () => {
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        new Response("registry leaked private-model", { status: 500 }),
    });

    const events = await collect(
      provider.downloadModel("qwen3:4b", new AbortController().signal),
    );

    expect(events).toEqual([
      { type: "started", model: "qwen3:4b" },
      {
        type: "failed",
        model: "qwen3:4b",
        error: expect.objectContaining({ code: "MODEL_DOWNLOAD_FAILED" }),
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-model");
  });

  it("releases the response body reader after normal chat completion", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              message: { content: "done", thinking: "" },
              done: true,
            })}\n`,
          ),
        );
        controller.close();
      },
    });
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => new Response(body),
    });

    await collect(
      provider.streamChat("request-cleanup", chatRequest, new AbortController().signal),
    );

    expect(body.locked).toBe(false);
  });

  it("cancels the response stream and yields cancelled when the caller aborts", async () => {
    let bodyCancelled = false;
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        openNdjsonResponse([], () => {
          bodyCancelled = true;
        }),
    });
    const caller = new AbortController();
    const events = provider.streamChat("request-cancel", chatRequest, caller.signal);
    const iterator = events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "started", requestId: "request-cancel" },
    });
    const pending = iterator.next();
    caller.abort();

    await expect(pending).resolves.toEqual({
      done: false,
      value: { type: "cancelled", requestId: "request-cancel" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(bodyCancelled).toBe(true);
  });

  it("yields FIRST_TOKEN_TIMEOUT when no first chunk arrives in time", async () => {
    vi.useFakeTimers();
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => openNdjsonResponse([], () => undefined),
      firstTokenTimeoutMs: 50,
      idleTimeoutMs: 500,
      overallTimeoutMs: 1000,
    });
    const events = provider.streamChat(
      "request-first",
      chatRequest,
      new AbortController().signal,
    );
    const iterator = events[Symbol.asyncIterator]();

    await iterator.next();
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(51);

    await expect(pending).resolves.toEqual({
      done: false,
      value: {
        type: "failed",
        requestId: "request-first",
        error: expect.objectContaining({ code: "FIRST_TOKEN_TIMEOUT" }),
      },
    });
  });

  it("yields STREAM_IDLE_TIMEOUT when a later chunk stalls", async () => {
    vi.useFakeTimers();
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        openNdjsonResponse(
          [
            {
              model: "qwen3:4b",
              created_at: "2026-08-29T10:00:00Z",
              message: { role: "assistant", content: "first", thinking: "" },
              done: false,
            },
          ],
          () => undefined,
        ),
      firstTokenTimeoutMs: 50,
      idleTimeoutMs: 100,
      overallTimeoutMs: 1000,
    });
    const events = provider.streamChat(
      "request-idle",
      chatRequest,
      new AbortController().signal,
    );
    const iterator = events[Symbol.asyncIterator]();

    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "delta", text: "first" },
    });
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(101);

    await expect(pending).resolves.toEqual({
      done: false,
      value: {
        type: "failed",
        requestId: "request-idle",
        error: expect.objectContaining({ code: "STREAM_IDLE_TIMEOUT" }),
      },
    });
  });

  it("maps a stalled connection to CONNECTION_TIMEOUT", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const provider = new OllamaProvider({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      connectionTimeoutMs: 25,
    });
    const pending = provider.checkHealth(new AbortController().signal);
    const expectation = expect(pending).rejects.toMatchObject({
      code: "CONNECTION_TIMEOUT",
      recoverable: true,
    } satisfies Partial<PublicError>);

    await vi.advanceTimersByTimeAsync(26);

    await expectation;
  });
});
