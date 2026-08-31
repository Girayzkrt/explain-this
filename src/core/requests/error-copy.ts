import type { PublicErrorCode } from "./public-error";

export type ErrorControlIntent =
  | "retry"
  | "open-setup"
  | "choose-model"
  | "show-origin-steps"
  | "select-less-text"
  | "continue-without-access"
  | "dismiss";

export interface ErrorPresentation {
  title: string;
  explanation: string;
  primaryAction: { intent: ErrorControlIntent; label: string };
}

export const ERROR_PRESENTATIONS: Record<PublicErrorCode, ErrorPresentation> = {
  OLLAMA_UNREACHABLE: {
    title: "Local model unavailable",
    explanation: "Explain This could not reach Ollama on this computer.",
    primaryAction: { intent: "open-setup", label: "Open setup" },
  },
  OLLAMA_ORIGIN_BLOCKED: {
    title: "Ollama needs this extension allowed",
    explanation: "Ollama rejected the extension’s local request.",
    primaryAction: { intent: "show-origin-steps", label: "Show origin steps" },
  },
  NO_MODEL: {
    title: "Choose a local model",
    explanation: "Ollama is ready, but no model is selected for explanations.",
    primaryAction: { intent: "choose-model", label: "Choose model" },
  },
  MODEL_NOT_FOUND: {
    title: "Selected model is unavailable",
    explanation: "The selected local model is no longer installed.",
    primaryAction: { intent: "choose-model", label: "Choose model" },
  },
  MODEL_DOWNLOAD_FAILED: {
    title: "Model download stopped",
    explanation: "The local model could not finish downloading.",
    primaryAction: { intent: "retry", label: "Try again" },
  },
  CONNECTION_TIMEOUT: {
    title: "Local model took too long to connect",
    explanation: "Ollama did not respond before the connection timed out.",
    primaryAction: { intent: "retry", label: "Try again" },
  },
  FIRST_TOKEN_TIMEOUT: {
    title: "Local model took too long to start",
    explanation: "The model did not begin an explanation in time.",
    primaryAction: { intent: "retry", label: "Try again" },
  },
  STREAM_IDLE_TIMEOUT: {
    title: "Local explanation stopped",
    explanation: "The model stopped responding before the explanation finished.",
    primaryAction: { intent: "retry", label: "Try again" },
  },
  MALFORMED_STREAM: {
    title: "Local response could not be read",
    explanation: "The model sent an incomplete response format.",
    primaryAction: { intent: "retry", label: "Try again" },
  },
  UNSUPPORTED_PAGE: {
    title: "This page cannot be explained here",
    explanation: "Explain This only works on supported web pages.",
    primaryAction: { intent: "dismiss", label: "Dismiss" },
  },
  PAGE_PERMISSION_DENIED: {
    title: "Page access was not allowed",
    explanation: "You can still use the context menu or keyboard shortcut.",
    primaryAction: {
      intent: "continue-without-access",
      label: "Continue without automatic access",
    },
  },
  EMPTY_SELECTION: {
    title: "Select text to explain",
    explanation: "Choose some text on the page, then try again.",
    primaryAction: { intent: "dismiss", label: "Dismiss" },
  },
  SELECTION_TOO_LARGE: {
    title: "Select less text",
    explanation: "The selected passage is too large for a local explanation.",
    primaryAction: { intent: "select-less-text", label: "Select less text" },
  },
  CONTEXT_TOO_LARGE: {
    title: "Nearby context is too large",
    explanation: "Use a smaller passage or continue without nearby context.",
    primaryAction: { intent: "select-less-text", label: "Select less text" },
  },
  REQUEST_CANCELLED: {
    title: "Explanation stopped",
    explanation: "The local explanation was cancelled before it finished.",
    primaryAction: { intent: "dismiss", label: "Dismiss" },
  },
  PROVIDER_ERROR: {
    title: "Local model could not finish",
    explanation: "Ollama could not complete this explanation.",
    primaryAction: { intent: "retry", label: "Try again" },
  },
  INVALID_REQUEST: {
    title: "That request is no longer available",
    explanation: "Select the passage again to start a new explanation.",
    primaryAction: { intent: "dismiss", label: "Dismiss" },
  },
  INVALID_ENDPOINT: {
    title: "Local model address needs setup",
    explanation: "Explain This can only use its approved local Ollama address.",
    primaryAction: { intent: "open-setup", label: "Open setup" },
  },
};

export function getErrorPresentation(code: PublicErrorCode): ErrorPresentation {
  return ERROR_PRESENTATIONS[code];
}
