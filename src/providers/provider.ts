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
  think: false;
  keepAlive: "5m";
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

export interface ModelInfo {
  id: string;
  displayName: string;
  sizeBytes?: number;
}

export interface ModelDetails extends ModelInfo {
  family?: string;
  parameterSize?: string;
}

export interface GenerationMetrics {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
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
