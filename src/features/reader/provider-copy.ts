import type { SelectedProvider } from "../settings/settings";

/**
 * The reader surfaces must never assert where a request is processed unless the
 * reader session says so. A session's `provider` is optional (older records and
 * anything not yet reported by the background lack it), so every case below,
 * including "unknown", must be true regardless of where the request actually ran.
 */
export interface ProviderCopy {
  kicker: string;
  ariaLabel: string;
  connecting: string;
  explaining: string;
}

const LOCAL: ProviderCopy = {
  kicker: "Local reader",
  ariaLabel: "Local explanation",
  connecting: "Connecting to local model…",
  explaining: "Explaining locally…",
};

const CLOUD: ProviderCopy = {
  kicker: "Cloud reader",
  ariaLabel: "Cloud explanation",
  connecting: "Connecting to Ollama's cloud…",
  explaining: "Explaining via Ollama's cloud…",
};

const UNKNOWN: ProviderCopy = {
  kicker: "Reader",
  ariaLabel: "Explanation",
  connecting: "Connecting…",
  explaining: "Explaining…",
};

export function providerCopy(provider: SelectedProvider | undefined): ProviderCopy {
  switch (provider) {
    case "ollama-local":
      return LOCAL;
    case "ollama-cloud":
      return CLOUD;
    default:
      return UNKNOWN;
  }
}
