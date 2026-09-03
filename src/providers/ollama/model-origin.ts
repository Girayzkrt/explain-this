import type { ModelOrigin } from "../provider";

export type { ModelOrigin };

/**
 * Ollama exposes no field saying whether a model runs in its cloud, so origin is inferred
 * from two unreliable signals: the naming convention, and the absence of local weights.
 * Anything that cannot be shown to be local stays "unknown", which every consumer treats
 * as cloud. Withholding a local model costs a step; admitting a cloud one breaks a promise.
 */
export function deriveModelOrigin(
  name: string,
  sizeBytes: number | undefined,
): ModelOrigin {
  if (name.toLowerCase().endsWith("-cloud")) return "cloud";
  if (sizeBytes !== undefined && sizeBytes > 0) return "local";
  return "unknown";
}
