import type { SelectedProvider } from "../../features/settings/settings";
import type { ModelOrigin } from "../../providers/provider";

export type ModeConsistency =
  "ok" | "cloud-model-in-local-mode" | "local-model-in-cloud-mode";

export function checkModeConsistency(
  mode: SelectedProvider,
  origin: ModelOrigin,
): ModeConsistency {
  if (mode === "ollama-local") {
    return origin === "local" ? "ok" : "cloud-model-in-local-mode";
  }
  return origin === "local" ? "local-model-in-cloud-mode" : "ok";
}

/**
 * Only the local-mode failure reaches the request path. A local model in cloud mode
 * disappoints the reader's expectation of quality; it does not send their reading anywhere
 * they were not told about, so it never refuses an answer.
 */
export function blocksRequest(result: ModeConsistency): boolean {
  return result === "cloud-model-in-local-mode";
}
