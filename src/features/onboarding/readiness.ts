import { buildChatRequest } from "../../core/prompts/prompt-builder";
import { PublicError } from "../../core/requests/public-error";
import type { ModelConcurrencyGate } from "../../core/requests/model-concurrency-gate";
import type { ReadingPreferences } from "../settings/settings";
import type { LlmProvider, PublicErrorShape } from "../../providers/provider";
import type { ReadinessResult } from "./contracts";

const READINESS_SELECTION = "This is a local readiness check.";
const SLOW_FIRST_TOKEN_MS = 30_000;
const SLOW_TOKENS_PER_SECOND = 5;

function fromShape(error: PublicErrorShape): PublicError {
  return new PublicError(error.code, error.message, error.recoverable);
}

export interface ReadinessDependencies {
  provider: LlmProvider;
  modelGate: ModelConcurrencyGate;
  now(): number;
}

export async function runReadiness(
  dependencies: ReadinessDependencies,
  model: string,
  preferences: ReadingPreferences,
  signal: AbortSignal,
): Promise<ReadinessResult> {
  return dependencies.modelGate.runExclusive(signal, async () => {
    const requestId = crypto.randomUUID();
    const request = buildChatRequest({
      requestId,
      action: "explain",
      selection: READINESS_SELECTION,
      preferences: { ...preferences, selectedModel: model },
    });
    const startedAt = dependencies.now();
    let firstTokenMs: number | undefined;
    let tokensPerSecond: number | undefined;

    for await (const event of dependencies.provider.streamChat(
      requestId,
      request,
      signal,
    )) {
      if (event.type === "delta" && firstTokenMs === undefined) {
        firstTokenMs = Math.max(0, dependencies.now() - startedAt);
      }
      if (event.type === "failed") throw fromShape(event.error);
      if (event.type === "cancelled") {
        throw new PublicError(
          "REQUEST_CANCELLED",
          "The readiness check was cancelled.",
          true,
        );
      }
      if (event.type === "completed") {
        const outputTokens = event.metrics?.outputTokens;
        const durationMs = event.metrics?.durationMs;
        if (
          outputTokens === undefined ||
          durationMs === undefined ||
          durationMs <= 0 ||
          firstTokenMs === undefined
        ) {
          throw new PublicError(
            "PROVIDER_ERROR",
            "Ollama did not return readiness metrics.",
            true,
          );
        }
        tokensPerSecond = (outputTokens * 1_000) / durationMs;
      }
    }

    if (firstTokenMs === undefined || tokensPerSecond === undefined) {
      throw new PublicError(
        "PROVIDER_ERROR",
        "The readiness check ended unexpectedly.",
        true,
      );
    }

    const warnings: ReadinessResult["warnings"] = [];
    if (firstTokenMs > SLOW_FIRST_TOKEN_MS) warnings.push("slow-first-token");
    if (tokensPerSecond < SLOW_TOKENS_PER_SECOND) warnings.push("slow-generation");
    return {
      status: warnings.length > 0 ? "warning" : "ready",
      firstTokenMs,
      tokensPerSecond,
      warnings,
    };
  });
}

export type { ReadinessResult } from "./contracts";
