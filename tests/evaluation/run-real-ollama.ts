import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChatRequest } from "../../src/core/prompts/prompt-builder";
import { enforceReadingBudget } from "../../src/core/requests/budget";
import { PublicError } from "../../src/core/requests/public-error";
import { estimateTokens } from "../../src/core/requests/token-estimator";
import type { ReadingRequest } from "../../src/core/requests/types";
import {
  createDefaultPreferences,
  type ReadingPreferences,
} from "../../src/features/settings/settings";
import { OllamaProvider } from "../../src/providers/ollama/ollama-provider";
import type { LlmProvider, ModelInfo } from "../../src/providers/provider";
import { OLLAMA_BASE_URL, RECOMMENDED_MODEL } from "../../src/shared/constants";
import {
  loadEvaluationCorpus,
  type EvaluationCase,
  type EvaluationCorpus,
} from "./schema";

/**
 * The runner is typed against `LlmProvider`, never `DownloadableModelProvider`, so
 * automatically pulling a model is impossible by construction rather than by policy.
 */
export interface EvaluationRunOptions {
  preflightOnly: boolean;
  saveResponses: boolean;
  artifactDirectory: string;
  model: typeof RECOMMENDED_MODEL;
}

export interface EvaluationDependencies {
  provider?: LlmProvider;
  corpus?: EvaluationCorpus;
  log?: (line: string) => void;
  writeArtifact?: (file: string, contents: string) => Promise<void>;
}

export interface CaseFinding {
  check: string;
  detail: string;
}

export interface CaseResponse {
  text: string;
  completed: boolean;
  numPredict: number;
  /** Set when the provider ended the stream with a public error. */
  errorCode?: string;
  /** The provider's measured output token count, authoritative when present. */
  outputTokens?: number;
  /** Ollama's terminal reason, used to distinguish a normal stop from truncation. */
  finishReason?: string;
}

export interface CaseResult {
  id: string;
  category: EvaluationCase["category"];
  action: EvaluationCase["action"];
  durationMs: number;
  outputTokens: number;
  findings: CaseFinding[];
  text: string;
}

/**
 * Matches both the tagged form and the bare underscored token. Reasoning models narrate
 * the scaffolding in prose ("we are given a selected_text"), which the tagged form misses.
 */
const PROMPT_DELIMITERS = /\b(?:selected_text|nearby_context|prior_answer)\b/iu;
/** The estimator is approximate, so allow modest slack before calling a ceiling breached. */
const OUTPUT_CEILING_TOLERANCE = 1.25;

export function parseEvaluationArgs(argv: readonly string[]): {
  preflightOnly: boolean;
  saveResponses: boolean;
} {
  let preflightOnly = false;
  let saveResponses = false;

  for (const argument of argv) {
    if (argument === "--preflight") preflightOnly = true;
    else if (argument === "--save-responses") saveResponses = true;
    else throw new Error(`Unsupported argument: ${argument}`);
  }

  return { preflightOnly, saveResponses };
}

export function checkResponse(
  entry: EvaluationCase,
  response: CaseResponse,
): CaseFinding[] {
  const findings: CaseFinding[] = [];

  if (response.errorCode !== undefined) {
    findings.push({
      check: "provider-error",
      detail: `The provider ended the stream with ${response.errorCode}.`,
    });
  }
  if (!response.completed) {
    findings.push({ check: "completion", detail: "The stream did not complete." });
  }
  if (response.finishReason === "length") {
    findings.push({
      check: "output-truncated",
      detail: `Ollama stopped at the ${response.numPredict}-token generation limit.`,
    });
  }
  if (response.text.trim().length === 0) {
    findings.push({ check: "non-empty-output", detail: "The model returned no text." });
  }

  // A measured count is authoritative; the character estimator is only a fallback and
  // overcounts English badly enough to invent ceiling breaches that cannot happen.
  if (response.outputTokens !== undefined) {
    if (response.outputTokens > response.numPredict) {
      findings.push({
        check: "output-ceiling",
        detail: `Generated ${response.outputTokens} tokens above the ${response.numPredict} ceiling.`,
      });
    }
  } else {
    const estimated = estimateTokens(response.text);
    if (estimated > response.numPredict * OUTPUT_CEILING_TOLERANCE) {
      findings.push({
        check: "output-ceiling",
        detail: `Estimated ${estimated} tokens above the ${response.numPredict} ceiling.`,
      });
    }
  }

  if (PROMPT_DELIMITERS.test(response.text)) {
    findings.push({
      check: "delimiter-leakage",
      detail: "The answer echoed a prompt delimiter.",
    });
  }

  const lowered = response.text.toLowerCase();
  for (const literal of entry.prohibitedLiterals) {
    if (lowered.includes(literal.toLowerCase())) {
      findings.push({
        check: "prohibited-literal",
        detail: `The answer contained the prohibited literal ${literal}.`,
      });
    }
  }

  return findings;
}

function preferencesFor(
  entry: EvaluationCase,
  model: EvaluationRunOptions["model"],
): ReadingPreferences {
  return {
    ...createDefaultPreferences(),
    preferredLanguage: entry.preferredLanguage,
    explanationLevel: entry.explanationLevel,
    preserveEnglishTerms: entry.preserveEnglishTerms,
    includeNearbyContext: entry.nearbyContext !== undefined,
    selectedModel: model,
  };
}

function readingRequestFor(
  entry: EvaluationCase,
  model: EvaluationRunOptions["model"],
): ReadingRequest {
  enforceReadingBudget({
    selection: entry.selection,
    nearbyContext: entry.nearbyContext,
    previousAnswer: entry.previousAnswer,
  });

  return {
    requestId: entry.id,
    action: entry.action,
    selection: entry.selection,
    preferences: preferencesFor(entry, model),
    ...(entry.followUpIntent === undefined
      ? {}
      : { followUpIntent: entry.followUpIntent }),
    ...(entry.nearbyContext === undefined
      ? {}
      : { nearbyContext: entry.nearbyContext }),
    ...(entry.previousAnswer === undefined
      ? {}
      : { previousAnswer: entry.previousAnswer }),
  };
}

async function generate(
  provider: LlmProvider,
  entry: EvaluationCase,
  model: EvaluationRunOptions["model"],
): Promise<CaseResponse> {
  const chatRequest = buildChatRequest(readingRequestFor(entry, model));
  const controller = new AbortController();
  let text = "";
  let completed = false;
  let errorCode: string | undefined;
  let outputTokens: number | undefined;
  let finishReason: string | undefined;

  for await (const event of provider.streamChat(
    entry.id,
    chatRequest,
    controller.signal,
  )) {
    if (event.type === "delta") text += event.text;
    else if (event.type === "completed") {
      completed = true;
      outputTokens = event.metrics?.outputTokens;
      finishReason = event.metrics?.finishReason;
    } else if (event.type === "failed") {
      errorCode = event.error.code;
      break;
    } else if (event.type === "cancelled") {
      errorCode = "REQUEST_CANCELLED";
      break;
    }
  }

  return {
    text,
    completed,
    numPredict: chatRequest.numPredict,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(finishReason === undefined ? {} : { finishReason }),
  };
}

function describeError(error: unknown): string {
  if (error instanceof PublicError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

const RUNTIME_HINT =
  "Start Ollama and re-run. This runner never starts or installs anything.";

const APPROVED_ARTIFACT_DIRECTORY = path.resolve(
  import.meta.dirname,
  "../../artifacts/evaluation",
);

function approvedArtifactDirectory(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (path.relative(APPROVED_ARTIFACT_DIRECTORY, resolved) !== "") {
    throw new Error(
      "Response artifact directory must be the git-ignored artifacts/evaluation directory.",
    );
  }
  return APPROVED_ARTIFACT_DIRECTORY;
}

/**
 * The real provider throws `PublicError` for an unreachable host rather than returning
 * `available: false`, so every probe call is guarded and reported as guidance.
 */
async function probeRuntime(
  provider: LlmProvider,
  model: string,
  signal: AbortSignal,
): Promise<{ ready: true } | { ready: false; lines: string[] }> {
  try {
    const health = await provider.checkHealth(signal);
    if (!health.available) {
      return {
        ready: false,
        lines: [
          `Ollama is not available at ${OLLAMA_BASE_URL} (status: ${health.status ?? "unknown"}).`,
          RUNTIME_HINT,
        ],
      };
    }
  } catch (error) {
    return {
      ready: false,
      lines: [
        `Could not reach Ollama at ${OLLAMA_BASE_URL}: ${describeError(error)}.`,
        RUNTIME_HINT,
      ],
    };
  }

  let models: ModelInfo[];
  try {
    models = await provider.listModels(signal);
  } catch (error) {
    return {
      ready: false,
      lines: [
        `Could not list local Ollama models: ${describeError(error)}.`,
        RUNTIME_HINT,
      ],
    };
  }

  if (!models.some((candidate) => candidate.id === model)) {
    return {
      ready: false,
      lines: [
        `The model ${model} is not installed locally.`,
        `Install it yourself with: ollama pull ${model}`,
        "This runner will not download a model automatically.",
      ],
    };
  }

  return { ready: true };
}

function reviewTable(results: readonly CaseResult[]): string {
  const rows = results.map((result) => {
    const status =
      result.findings.length === 0 ? "ok" : `${result.findings.length} issue`;
    return [
      result.id.padEnd(38),
      result.action.padEnd(9),
      `${result.durationMs}ms`.padStart(8),
      `${result.outputTokens}t`.padStart(6),
      status,
    ].join("  ");
  });
  return rows.join("\n");
}

export async function runEvaluation(
  options: EvaluationRunOptions,
  dependencies: EvaluationDependencies = {},
): Promise<number> {
  const artifactDirectory = options.saveResponses
    ? approvedArtifactDirectory(options.artifactDirectory)
    : undefined;
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const provider =
    dependencies.provider ??
    // Deliberately uses the shipped provider defaults, so a successful run is evidence
    // that production transport budgets work on this hardware.
    new OllamaProvider({ baseUrl: OLLAMA_BASE_URL });
  const corpus = dependencies.corpus ?? (await loadEvaluationCorpus());
  const controller = new AbortController();

  const probe = await probeRuntime(provider, options.model, controller.signal);
  if (!probe.ready) {
    for (const line of probe.lines) log(line);
    return 1;
  }

  if (options.preflightOnly) {
    log(`Preflight passed: Ollama reachable and ${options.model} installed.`);
    log(`${corpus.cases.length} cases are ready; no generation was performed.`);
    return 0;
  }

  const results: CaseResult[] = [];
  for (const entry of corpus.cases) {
    const startedAt = Date.now();
    const response = await generate(provider, entry, options.model);
    results.push({
      id: entry.id,
      category: entry.category,
      action: entry.action,
      durationMs: Date.now() - startedAt,
      outputTokens: response.outputTokens ?? estimateTokens(response.text),
      findings: checkResponse(entry, response),
      text: response.text,
    });
  }

  const flagged = results.filter((result) => result.findings.length > 0);
  const totalMs = results.reduce((sum, result) => sum + result.durationMs, 0);

  log(reviewTable(results));
  log("");
  log(`${results.length} cases in ${totalMs}ms; ${flagged.length} need review.`);
  for (const result of flagged) {
    for (const finding of result.findings) {
      log(`  ${result.id}: ${finding.check} — ${finding.detail}`);
    }
  }
  log("Automated checks are mechanical only. Score quality by hand with rubric.md.");

  if (options.saveResponses) {
    const file = path.join(
      artifactDirectory!,
      `run-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
    );
    const write =
      dependencies.writeArtifact ??
      (async (target: string, contents: string) => {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents, "utf8");
      });
    await write(
      file,
      `${JSON.stringify({ version: corpus.version, results }, null, 2)}\n`,
    );
    log(`Full responses written to ${file} (git-ignored).`);
  }

  return flagged.length === 0 ? 0 : 1;
}

export const USAGE = "Usage: npm run test:ollama -- [--preflight] [--save-responses]";

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseEvaluationArgs>;
  try {
    parsed = parseEvaluationArgs(process.argv.slice(2));
  } catch (error) {
    // A mistyped flag is a usage error, not a crash; exit 2 keeps it distinct from findings.
    console.error(describeError(error));
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const exitCode = await runEvaluation({
    preflightOnly: parsed.preflightOnly,
    saveResponses: parsed.saveResponses,
    artifactDirectory: "artifacts/evaluation",
    model: RECOMMENDED_MODEL,
  });
  process.exitCode = exitCode;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined) {
  const invokedDirectly =
    path.resolve(entryPoint) === path.resolve(fileURLToPath(import.meta.url));
  if (invokedDirectly) {
    await main();
  }
}
