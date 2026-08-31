import type { PublicErrorCode } from "../../core/requests/public-error";

const MAX_TEXT_LENGTH = 128;
const MAX_MODEL_SIZE_BYTES = 1_000_000_000_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_TOKEN_COUNT = 1_000_000;
const PUBLIC_ERROR_CODES = new Set<PublicErrorCode>([
  "OLLAMA_UNREACHABLE",
  "OLLAMA_ORIGIN_BLOCKED",
  "NO_MODEL",
  "MODEL_NOT_FOUND",
  "MODEL_DOWNLOAD_FAILED",
  "CONNECTION_TIMEOUT",
  "FIRST_TOKEN_TIMEOUT",
  "STREAM_IDLE_TIMEOUT",
  "MALFORMED_STREAM",
  "UNSUPPORTED_PAGE",
  "PAGE_PERMISSION_DENIED",
  "EMPTY_SELECTION",
  "SELECTION_TOO_LARGE",
  "CONTEXT_TOO_LARGE",
  "REQUEST_CANCELLED",
  "PROVIDER_ERROR",
  "INVALID_REQUEST",
  "INVALID_ENDPOINT",
]);

export interface DiagnosticFacts {
  extensionVersion?: unknown;
  platform?: unknown;
  endpoint?: unknown;
  selectedModel?: unknown;
  errorCode?: unknown;
  metrics?: unknown;
  automaticToolbar?: unknown;
  onboardingVersion?: unknown;
  [key: string]: unknown;
}

export interface SanitizedDiagnosticReport {
  extensionVersion: string;
  platform: string;
  endpoint: { hostname: "127.0.0.1" | "localhost"; port: 11434 };
  model?: { name: string; family?: string; sizeBytes?: number; quantization?: string };
  errorCode?: PublicErrorCode;
  metrics?: { durationMs?: number; promptTokens?: number; outputTokens?: number };
  permissions: { automaticToolbar: boolean };
  onboardingVersion: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function own(input: Record<string, unknown> | undefined, key: string): unknown {
  try {
    if (!input || !Object.hasOwn(input, key)) return undefined;
    return input[key];
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_TEXT_LENGTH
    ? normalized
    : undefined;
}

function boundedNumber(value: unknown, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
    ? value
    : undefined;
}

function endpointHostname(value: unknown): "127.0.0.1" | "localhost" {
  const hostname = own(object(value), "hostname");
  return hostname === "localhost" ? "localhost" : "127.0.0.1";
}

function sanitizedModel(value: unknown): SanitizedDiagnosticReport["model"] {
  const input = object(value);
  const name = boundedString(own(input, "name"));
  if (!name) return undefined;
  const family = boundedString(own(input, "family"));
  const sizeBytes = boundedNumber(own(input, "sizeBytes"), MAX_MODEL_SIZE_BYTES);
  const quantization = boundedString(own(input, "quantization"));
  return {
    name,
    ...(family === undefined ? {} : { family }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(quantization === undefined ? {} : { quantization }),
  };
}

function sanitizedMetrics(value: unknown): SanitizedDiagnosticReport["metrics"] {
  const input = object(value);
  const durationMs = boundedNumber(own(input, "durationMs"), MAX_DURATION_MS);
  const promptTokens = boundedNumber(own(input, "promptTokens"), MAX_TOKEN_COUNT);
  const outputTokens = boundedNumber(own(input, "outputTokens"), MAX_TOKEN_COUNT);
  return durationMs === undefined &&
    promptTokens === undefined &&
    outputTokens === undefined
    ? undefined
    : {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
      };
}

export function createSanitizedDiagnosticReport(
  input: DiagnosticFacts,
): SanitizedDiagnosticReport {
  const facts = object(input) ?? {};
  const extensionVersion = boundedString(own(facts, "extensionVersion")) ?? "unknown";
  const platform = boundedString(own(facts, "platform")) ?? "unknown";
  const errorCode = own(facts, "errorCode");
  const onboardingVersion = own(facts, "onboardingVersion");
  const model = sanitizedModel(own(facts, "selectedModel"));
  const metrics = sanitizedMetrics(own(facts, "metrics"));

  return {
    extensionVersion,
    platform,
    endpoint: { hostname: endpointHostname(own(facts, "endpoint")), port: 11434 },
    ...(model === undefined ? {} : { model }),
    ...(typeof errorCode === "string" &&
    PUBLIC_ERROR_CODES.has(errorCode as PublicErrorCode)
      ? { errorCode: errorCode as PublicErrorCode }
      : {}),
    ...(metrics === undefined ? {} : { metrics }),
    permissions: { automaticToolbar: own(facts, "automaticToolbar") === true },
    onboardingVersion: onboardingVersion === 1 ? 1 : 0,
  };
}

export function serializeDiagnosticReport(report: SanitizedDiagnosticReport): string {
  return JSON.stringify(report, null, 2);
}
