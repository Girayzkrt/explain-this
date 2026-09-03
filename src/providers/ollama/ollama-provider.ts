import { PublicError } from "../../core/requests/public-error";
import { parseNdjson } from "../../core/streaming/ndjson";
import type {
  ChatRequest,
  DownloadableModelProvider,
  GenerationMetrics,
  ModelDownloadEvent,
  ModelDetails,
  ModelInfo,
  ProviderHealth,
  StreamEvent,
} from "../provider";
import { mapOllamaFailure, mapOllamaResponseError, toPublicErrorShape } from "./errors";
import { deriveModelOrigin } from "./model-origin";
import {
  ollamaChatChunkSchema,
  ollamaModelDetailsSchema,
  ollamaPullChunkSchema,
  ollamaTagsSchema,
  type OllamaChatChunk,
  type OllamaPullChunk,
} from "./schemas";
import { normalizeOllamaBaseUrl } from "./url";

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60_000;

export interface OllamaProviderOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  connectionTimeoutMs?: number;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  overallTimeoutMs?: number;
}

interface Operation {
  controller: AbortController;
  callerAborted: () => boolean;
  cleanup: () => void;
}

function timeoutError(
  code: "CONNECTION_TIMEOUT" | "FIRST_TOKEN_TIMEOUT" | "STREAM_IDLE_TIMEOUT",
  message: string,
): PublicError {
  return new PublicError(code, message, true);
}

function startOperation(
  callerSignal: AbortSignal,
  overallTimeoutMs: number,
): Operation {
  const controller = new AbortController();
  const forwardCallerAbort = (): void => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) forwardCallerAbort();
  else callerSignal.addEventListener("abort", forwardCallerAbort, { once: true });

  const overallTimer = setTimeout(
    () =>
      controller.abort(
        new PublicError("PROVIDER_ERROR", "The model request took too long.", true),
      ),
    overallTimeoutMs,
  );

  return {
    controller,
    callerAborted: () => callerSignal.aborted,
    cleanup: () => {
      clearTimeout(overallTimer);
      callerSignal.removeEventListener("abort", forwardCallerAbort);
    },
  };
}

function responseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new PublicError("MALFORMED_STREAM", "The model response was invalid.", true);
  }
  return response.body;
}

function completionMetrics(chunk: OllamaChatChunk): GenerationMetrics | undefined {
  const metrics: GenerationMetrics = {};
  if (chunk.prompt_eval_count !== undefined)
    metrics.inputTokens = chunk.prompt_eval_count;
  if (chunk.eval_count !== undefined) metrics.outputTokens = chunk.eval_count;
  if (chunk.total_duration !== undefined)
    metrics.durationMs = chunk.total_duration / 1_000_000;
  if (chunk.done_reason !== undefined) metrics.finishReason = chunk.done_reason;
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export class OllamaProvider implements DownloadableModelProvider {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly connectionTimeoutMs: number;
  private readonly firstTokenTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly overallTimeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = normalizeOllamaBaseUrl(options.baseUrl);
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis);
    this.connectionTimeoutMs =
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.firstTokenTimeoutMs =
      options.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  }

  async checkHealth(signal: AbortSignal): Promise<ProviderHealth> {
    await this.fetchTags(signal);
    return { available: true };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const tags = await this.fetchTags(signal);
    return tags.models.map((model) => ({
      id: model.name,
      displayName: model.name,
      ...(model.size === undefined ? {} : { sizeBytes: model.size }),
      origin: deriveModelOrigin(model.name, model.size),
    }));
  }

  async getModelDetails(model: string, signal: AbortSignal): Promise<ModelDetails> {
    const operation = startOperation(signal, this.overallTimeoutMs);
    let response: Response | undefined;
    let completedNormally = false;

    try {
      response = await this.fetchWithConnectionTimeout(
        "api/show",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({ model }),
        },
        operation.controller,
      );
      if (!response.ok) throw mapOllamaResponseError(response);

      const ollamaDetails = ollamaModelDetailsSchema.parse(await response.json());
      const details: ModelDetails = {
        id: model,
        displayName: model,
        origin: deriveModelOrigin(model, undefined),
      };
      if (ollamaDetails.details.family !== undefined) {
        details.family = ollamaDetails.details.family;
      }
      if (ollamaDetails.details.parameter_size !== undefined) {
        details.parameterSize = ollamaDetails.details.parameter_size;
      }
      completedNormally = true;
      return details;
    } catch (error) {
      throw mapOllamaFailure(error, operation.controller.signal);
    } finally {
      operation.cleanup();
      if (response?.body && !completedNormally && !response.bodyUsed) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }

  async *streamChat(
    requestId: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const operation = startOperation(signal, this.overallTimeoutMs);
    let response: Response | undefined;
    let parser: AsyncGenerator<OllamaChatChunk> | undefined;
    let completedNormally = false;

    // A per-request budget (see ChatRequest.firstTokenTimeoutMs) overrides this
    // provider's constructor default, so the same instance can serve both local and
    // cloud modes without being rebuilt when the mode changes.
    const firstTokenTimeoutMs = request.firstTokenTimeoutMs ?? this.firstTokenTimeoutMs;

    try {
      yield { type: "started", requestId };
      const firstTokenDeadline = Date.now() + firstTokenTimeoutMs;
      response = await this.fetchWithConnectionTimeout(
        "api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: true,
            think: false,
            keep_alive: request.keepAlive,
            options: {
              num_ctx: request.numCtx,
              num_predict: request.numPredict,
              temperature: request.temperature,
              top_p: request.topP,
              top_k: request.topK,
              repeat_penalty: request.repeatPenalty,
              stop: [...request.stop],
            },
          }),
        },
        operation.controller,
        firstTokenTimeoutMs,
        () =>
          timeoutError(
            "FIRST_TOKEN_TIMEOUT",
            "Ollama did not start responding in time.",
          ),
      );
      if (!response.ok) throw mapOllamaResponseError(response);

      parser = parseNdjson(
        responseBody(response),
        (input) => ollamaChatChunkSchema.parse(input),
        operation.controller.signal,
      );
      let sequence = 0;
      let waitingForFirstChunk = true;

      while (true) {
        const waitMs = waitingForFirstChunk
          ? Math.max(0, firstTokenDeadline - Date.now())
          : this.idleTimeoutMs;
        const waitError = waitingForFirstChunk
          ? timeoutError(
              "FIRST_TOKEN_TIMEOUT",
              "Ollama did not start responding in time.",
            )
          : timeoutError(
              "STREAM_IDLE_TIMEOUT",
              "The Ollama response stopped arriving.",
            );
        const timer = setTimeout(() => operation.controller.abort(waitError), waitMs);
        let next: IteratorResult<OllamaChatChunk>;
        try {
          next = await parser.next();
        } finally {
          clearTimeout(timer);
        }

        if (next.done) {
          throw new PublicError(
            "MALFORMED_STREAM",
            "The model response ended unexpectedly.",
            true,
          );
        }
        waitingForFirstChunk = false;
        const chunk = next.value;

        if (chunk.message.content !== "") {
          yield {
            type: "delta",
            requestId,
            sequence,
            text: chunk.message.content,
          };
          sequence += 1;
        }

        if (chunk.done) {
          const metrics = completionMetrics(chunk);
          completedNormally = true;
          if (metrics) yield { type: "completed", requestId, metrics };
          else yield { type: "completed", requestId };
          return;
        }
      }
    } catch (error) {
      if (operation.callerAborted()) {
        yield { type: "cancelled", requestId };
      } else {
        const publicError = mapOllamaFailure(error, operation.controller.signal);
        yield { type: "failed", requestId, error: toPublicErrorShape(publicError) };
      }
    } finally {
      operation.cleanup();
      if (parser) await parser.return(undefined).catch(() => undefined);
      if (response?.body && !completedNormally) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }

  async *downloadModel(
    model: string,
    signal: AbortSignal,
  ): AsyncIterable<ModelDownloadEvent> {
    const operation = startOperation(signal, this.overallTimeoutMs);
    let response: Response | undefined;
    let parser: AsyncGenerator<OllamaPullChunk> | undefined;
    let completedNormally = false;

    try {
      yield { type: "started", model };
      response = await this.fetchWithConnectionTimeout(
        "api/pull",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({ model, stream: true }),
        },
        operation.controller,
      );
      if (!response.ok) throw mapOllamaResponseError(response, "download");

      parser = parseNdjson(
        responseBody(response),
        (input) => ollamaPullChunkSchema.parse(input),
        operation.controller.signal,
      );
      let waitingForFirstChunk = true;

      while (true) {
        const waitMs = waitingForFirstChunk
          ? this.firstTokenTimeoutMs
          : this.idleTimeoutMs;
        const waitError = waitingForFirstChunk
          ? timeoutError(
              "FIRST_TOKEN_TIMEOUT",
              "Ollama did not start responding in time.",
            )
          : timeoutError(
              "STREAM_IDLE_TIMEOUT",
              "The Ollama response stopped arriving.",
            );
        const timer = setTimeout(() => operation.controller.abort(waitError), waitMs);
        let next: IteratorResult<OllamaPullChunk>;
        try {
          next = await parser.next();
        } finally {
          clearTimeout(timer);
        }

        if (next.done) {
          throw new PublicError(
            "MODEL_DOWNLOAD_FAILED",
            "The model download ended unexpectedly.",
            true,
          );
        }
        waitingForFirstChunk = false;
        const chunk = next.value;

        if (chunk.completed !== undefined) {
          if (chunk.total !== undefined) {
            yield {
              type: "progress",
              model,
              completedBytes: chunk.completed,
              totalBytes: chunk.total,
            };
          } else {
            yield { type: "progress", model, completedBytes: chunk.completed };
          }
        }

        if (chunk.status === "success") {
          completedNormally = true;
          yield { type: "completed", model };
          return;
        }
      }
    } catch (error) {
      const publicError = mapOllamaFailure(error, operation.controller.signal);
      yield { type: "failed", model, error: toPublicErrorShape(publicError) };
    } finally {
      operation.cleanup();
      if (parser) await parser.return(undefined).catch(() => undefined);
      if (response?.body && !completedNormally) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }

  private async fetchTags(
    signal: AbortSignal,
  ): Promise<ReturnType<typeof ollamaTagsSchema.parse>> {
    const operation = startOperation(signal, this.overallTimeoutMs);
    let response: Response | undefined;
    let completedNormally = false;
    try {
      response = await this.fetchWithConnectionTimeout(
        "api/tags",
        { method: "GET", credentials: "omit" },
        operation.controller,
      );
      if (!response.ok) throw mapOllamaResponseError(response);
      const tags = ollamaTagsSchema.parse(await response.json());
      completedNormally = true;
      return tags;
    } catch (error) {
      throw mapOllamaFailure(error, operation.controller.signal);
    } finally {
      operation.cleanup();
      if (response?.body && !completedNormally && !response.bodyUsed) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }

  /**
   * Ollama withholds response headers until it has work to report, so for generation the
   * wait for headers is first-token latency, not connection latency. Callers on those
   * endpoints pass their own budget; reusing the connection budget there would report
   * CONNECTION_TIMEOUT, which onboarding maps to OLLAMA_UNREACHABLE.
   */
  private async fetchWithConnectionTimeout(
    path: string,
    init: RequestInit,
    controller: AbortController,
    timeoutMs: number = this.connectionTimeoutMs,
    onTimeout: () => PublicError = () =>
      timeoutError("CONNECTION_TIMEOUT", "The connection to Ollama timed out."),
  ): Promise<Response> {
    const timer = setTimeout(() => controller.abort(onTimeout()), timeoutMs);
    try {
      return await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createOllamaProvider(
  options: OllamaProviderOptions,
): DownloadableModelProvider {
  return new OllamaProvider(options);
}
