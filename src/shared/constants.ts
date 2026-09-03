import type { SelectedProvider } from "../features/settings/settings";

export const OLLAMA_BASE_URL =
  typeof __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__ === "undefined"
    ? "http://127.0.0.1:11434"
    : __EXPLAIN_THIS_E2E_OLLAMA_BASE_URL__;
/** Shortened stream timeouts exist only in an e2e package; production keeps provider defaults. */
export const E2E_STREAM_TIMEOUT_MS =
  typeof __EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__ === "undefined"
    ? undefined
    : __EXPLAIN_THIS_E2E_STREAM_TIMEOUT_MS__;
export const RECOMMENDED_MODEL = "gemma3:4b";
/** Same family as RECOMMENDED_MODEL; not a reasoning model, unlike gpt-oss, which
 * this project's evaluation corpus found unusable here (25/25 cases cut off
 * mid-deliberation before an answer). See README.md's reasoning-model warning. */
export const RECOMMENDED_CLOUD_MODEL = "gemma4:31b-cloud";
export const ONBOARDING_VERSION = 1;

/**
 * Local inference pays for model loading before the first token; a cold gemma3:4b was
 * measured at 30656 ms on 2026-09-02, so the local budget must clear that with margin.
 * Cloud inference loads nothing, so a long budget there only delays reporting a stall.
 * The cloud figure is provisional judgement, not measurement, until it can be checked
 * against a signed-in Ollama Cloud installation; replace it once that number exists.
 */
export function firstTokenBudgetMs(mode: SelectedProvider): number {
  return mode === "ollama-local" ? 60_000 : 20_000;
}
