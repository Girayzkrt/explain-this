import type { PublicErrorCode } from "../core/requests/public-error";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  numCtx: number;
  numPredict: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  /** Guards against the model closing the prompt structure instead of stopping. */
  stop: readonly string[];
  think: false;
  keepAlive: "5m";
  /**
   * Overrides the provider's constructor default for this request only, so the caller
   * can size the wait for the first token to the mode actually running (see
   * `firstTokenBudgetMs` in `src/shared/constants.ts`). Absent, the provider keeps its
   * own default.
   */
  firstTokenTimeoutMs?: number;
}

export interface PublicErrorShape {
  code: PublicErrorCode;
  message: string;
  recoverable: boolean;
}

export interface ProviderHealth {
  available: boolean;
  status?: "ready" | "model-required" | "unreachable" | "origin-blocked" | "error";
  message?: string;
  error?: PublicErrorShape;
  secondaryAction?: "show-origin-guidance";
}

export type ModelOrigin = "local" | "cloud" | "unknown";

export interface ModelInfo {
  id: string;
  displayName: string;
  sizeBytes?: number;
  origin: ModelOrigin;
}

export interface ModelDetails extends ModelInfo {
  family?: string;
  parameterSize?: string;
}

export interface GenerationMetrics {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Ollama's terminal reason, such as `stop` or `length`. */
  finishReason?: string;
}

export type StreamEvent =
  | { type: "started"; requestId: string }
  | { type: "delta"; requestId: string; sequence: number; text: string }
  | { type: "completed"; requestId: string; metrics?: GenerationMetrics }
  | { type: "cancelled"; requestId: string }
  | { type: "failed"; requestId: string; error: PublicErrorShape };

export type ModelDownloadEvent =
  | { type: "started"; model: string }
  | { type: "progress"; model: string; completedBytes: number; totalBytes?: number }
  | { type: "completed"; model: string }
  | { type: "failed"; model: string; error: PublicErrorShape };

export interface LlmProvider {
  checkHealth(signal: AbortSignal): Promise<ProviderHealth>;
  listModels(signal: AbortSignal): Promise<ModelInfo[]>;
  getModelDetails(model: string, signal: AbortSignal): Promise<ModelDetails>;
  streamChat(
    requestId: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

export interface DownloadableModelProvider extends LlmProvider {
  downloadModel(model: string, signal: AbortSignal): AsyncIterable<ModelDownloadEvent>;
}
