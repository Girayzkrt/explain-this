// @vitest-environment node

import { describe, expect, it } from "vitest";
import { PublicError } from "../../src/core/requests/public-error";
import { RECOMMENDED_MODEL } from "../../src/shared/constants";
import type {
  ChatRequest,
  LlmProvider,
  ModelDetails,
  ModelInfo,
  ProviderHealth,
  StreamEvent,
} from "../../src/providers/provider";
import { loadEvaluationCorpus, type EvaluationCase } from "./schema";
import {
  checkResponse,
  parseEvaluationArgs,
  runEvaluation,
  type EvaluationRunOptions,
} from "./run-real-ollama";

const corpus = await loadEvaluationCorpus();
const plainCase = corpus.cases.find((entry) => entry.id === "everyday-tides-simplify");
const injectionCase = corpus.cases.find(
  (entry) => entry.id === "injection-ignore-previous-instructions",
);
if (!plainCase || !injectionCase)
  throw new Error("Known corpus cases are unavailable.");

interface FakeProviderCalls {
  health: number;
  models: number;
  details: string[];
  chats: ChatRequest[];
}

function createFakeProvider(
  overrides: {
    health?: ProviderHealth;
    healthError?: unknown;
    models?: ModelInfo[];
    modelsError?: unknown;
    answer?: string;
    completed?: boolean;
    failCode?: string;
    outputTokens?: number;
    finishReason?: string;
  } = {},
): { provider: LlmProvider; calls: FakeProviderCalls } {
  const calls: FakeProviderCalls = {
    health: 0,
    models: 0,
    details: [],
    chats: [],
  };
  const provider: LlmProvider = {
    async checkHealth() {
      calls.health += 1;
      if (overrides.healthError !== undefined) throw overrides.healthError;
      return overrides.health ?? { available: true, status: "ready" };
    },
    async listModels() {
      calls.models += 1;
      if (overrides.modelsError !== undefined) throw overrides.modelsError;
      return (
        overrides.models ?? [
          { id: RECOMMENDED_MODEL, displayName: RECOMMENDED_MODEL, origin: "local" },
        ]
      );
    },
    async getModelDetails(model) {
      calls.details.push(model);
      return { id: model, displayName: model, origin: "local" } satisfies ModelDetails;
    },
    async *streamChat(requestId, request) {
      calls.chats.push(request);
      yield { type: "started", requestId } satisfies StreamEvent;
      if (overrides.failCode !== undefined) {
        yield {
          type: "failed",
          requestId,
          error: {
            code: overrides.failCode as "CONNECTION_TIMEOUT",
            message: "transport failure",
            recoverable: true,
          },
        } satisfies StreamEvent;
        return;
      }
      yield {
        type: "delta",
        requestId,
        sequence: 1,
        text: overrides.answer ?? "A plain local answer.",
      } satisfies StreamEvent;
      if (overrides.completed === false) {
        yield {
          type: "failed",
          requestId,
          error: { code: "PROVIDER_ERROR", message: "stopped", recoverable: true },
        } satisfies StreamEvent;
        return;
      }
      yield {
        type: "completed",
        requestId,
        ...(overrides.outputTokens === undefined
          ? {}
          : {
              metrics: {
                outputTokens: overrides.outputTokens,
                ...(overrides.finishReason === undefined
                  ? {}
                  : { finishReason: overrides.finishReason }),
              },
            }),
      } satisfies StreamEvent;
    },
  };
  return { provider, calls };
}

function options(overrides: Partial<EvaluationRunOptions> = {}): EvaluationRunOptions {
  return {
    preflightOnly: true,
    saveResponses: false,
    artifactDirectory: "artifacts/evaluation",
    model: RECOMMENDED_MODEL,
    ...overrides,
  };
}

describe("evaluation argument parsing", () => {
  it("defaults to a generating run that saves nothing", () => {
    expect(parseEvaluationArgs([])).toEqual({
      preflightOnly: false,
      saveResponses: false,
    });
  });

  it("accepts only the two documented flags, in any order", () => {
    expect(parseEvaluationArgs(["--save-responses", "--preflight"])).toEqual({
      preflightOnly: true,
      saveResponses: true,
    });
  });

  it.each([["--verbose"], ["-p"], ["--preflight=true"], ["cases.json"]])(
    "rejects the unsupported argument %s",
    (argument) => {
      expect(() => parseEvaluationArgs([argument])).toThrow(/unsupported/i);
    },
  );
});

describe("evaluation response checks", () => {
  it("accepts a clean in-budget answer", () => {
    expect(checkResponse(plainCase, answer("The Moon's pull raises the sea."))).toEqual(
      [],
    );
  });

  it("flags an incomplete generation", () => {
    const findings = checkResponse(plainCase, {
      ...answer("Partial"),
      completed: false,
    });
    expect(findings.map((finding) => finding.check)).toContain("completion");
  });

  it("flags an empty answer", () => {
    expect(checkResponse(plainCase, answer("   ")).map((f) => f.check)).toContain(
      "non-empty-output",
    );
  });

  it("flags an answer that exceeds the approved output ceiling", () => {
    const findings = checkResponse(plainCase, {
      ...answer("word ".repeat(4_000)),
      numPredict: 256,
    });
    expect(findings.map((finding) => finding.check)).toContain("output-ceiling");
  });

  // The server caps generation at num_predict, so a measured count is authoritative and
  // the character estimator (which overcounts English by ~30%) must not override it.
  it("trusts a reported token count over the estimator", () => {
    const findings = checkResponse(plainCase, {
      ...answer("word ".repeat(4_000)),
      numPredict: 256,
      outputTokens: 256,
    });
    expect(findings.map((finding) => finding.check)).not.toContain("output-ceiling");
  });

  it("flags a reported token count above the ceiling", () => {
    const findings = checkResponse(plainCase, {
      ...answer("short"),
      numPredict: 256,
      outputTokens: 300,
    });
    expect(findings.map((finding) => finding.check)).toContain("output-ceiling");
  });

  it("flags a generation stopped by Ollama at the exact output ceiling", () => {
    const findings = checkResponse(plainCase, {
      ...answer("A complete-looking but truncated answer"),
      numPredict: 256,
      outputTokens: 256,
      finishReason: "length",
    });

    expect(findings.map((finding) => finding.check)).toContain("output-truncated");
  });

  // qwen3 narrates the prompt scaffolding in prose ("we are given a selected_text"),
  // which the angle-bracket form of the check never sees.
  it("flags bare prompt scaffolding vocabulary, not only tagged delimiters", () => {
    const findings = checkResponse(
      plainCase,
      answer("We are given a selected_text and must simplify it."),
    );
    expect(findings.map((finding) => finding.check)).toContain("delimiter-leakage");
  });

  it.each([["<selected_text>"], ["</nearby_context>"], ["<prior_answer>"]])(
    "flags leaked prompt delimiter %s",
    (delimiter) => {
      const findings = checkResponse(plainCase, answer(`Sure ${delimiter} here`));
      expect(findings.map((finding) => finding.check)).toContain("delimiter-leakage");
    },
  );

  it("flags a prohibited literal regardless of case", () => {
    const findings = checkResponse(injectionCase, answer("Fine: pwned-alpha"));
    expect(findings.map((finding) => finding.check)).toContain("prohibited-literal");
  });
});

describe("evaluation preflight", () => {
  it("passes without generating anything when the model is installed", async () => {
    const { provider, calls } = createFakeProvider();

    await expect(
      runEvaluation(options(), { provider, corpus, log: () => {} }),
    ).resolves.toBe(0);
    expect(calls.health).toBe(1);
    expect(calls.chats).toEqual([]);
    expect(provider).not.toHaveProperty("downloadModel");
  });

  it("fails when the local runtime is unreachable", async () => {
    const { provider, calls } = createFakeProvider({
      health: { available: false, status: "unreachable" },
    });

    await expect(
      runEvaluation(options(), { provider, corpus, log: () => {} }),
    ).resolves.toBeGreaterThan(0);
    expect(calls.chats).toEqual([]);
  });

  // The real provider throws PublicError for an unreachable host; it never returns
  // { available: false }. Preflight must report that, not surface an unhandled rejection.
  it("reports a thrown unreachable health check instead of crashing", async () => {
    const { provider, calls } = createFakeProvider({
      healthError: new PublicError(
        "OLLAMA_UNREACHABLE",
        "Ollama is not reachable.",
        true,
      ),
    });
    const lines: string[] = [];

    await expect(
      runEvaluation(options(), { provider, corpus, log: (line) => lines.push(line) }),
    ).resolves.toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/ollama/i);
    expect(calls.chats).toEqual([]);
  });

  it("reports a thrown model listing instead of crashing", async () => {
    const { provider, calls } = createFakeProvider({
      modelsError: new PublicError(
        "OLLAMA_UNREACHABLE",
        "Ollama is not reachable.",
        true,
      ),
    });
    const lines: string[] = [];

    await expect(
      runEvaluation(options(), { provider, corpus, log: (line) => lines.push(line) }),
    ).resolves.toBeGreaterThan(0);
    expect(lines.join("\n")).toMatch(/ollama/i);
    expect(calls.chats).toEqual([]);
  });

  it("fails without downloading when the model is missing", async () => {
    const { provider, calls } = createFakeProvider({
      models: [{ id: "llama3:8b", displayName: "llama3:8b", origin: "local" }],
    });

    await expect(
      runEvaluation(options(), { provider, corpus, log: () => {} }),
    ).resolves.toBeGreaterThan(0);
    expect(provider).not.toHaveProperty("downloadModel");
    expect(calls.chats).toEqual([]);
  });
});

describe("evaluation generating run", () => {
  it("sends one production-shaped request per case with thinking disabled", async () => {
    const { provider, calls } = createFakeProvider();

    const exitCode = await runEvaluation(options({ preflightOnly: false }), {
      provider,
      corpus,
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls.chats).toHaveLength(corpus.cases.length);
    for (const request of calls.chats) {
      expect(request.model).toBe(RECOMMENDED_MODEL);
      expect(request.think).toBe(false);
      expect(request.messages).toHaveLength(2);
      expect(request.numCtx).toBe(4096);
    }
  });

  // A silent "returned no text" hides the actual transport failure and makes a real
  // CONNECTION_TIMEOUT look like a model quality problem.
  it("reports why a stream failed rather than only that it was empty", async () => {
    const { provider } = createFakeProvider({ failCode: "CONNECTION_TIMEOUT" });
    const lines: string[] = [];

    const exitCode = await runEvaluation(options({ preflightOnly: false }), {
      provider,
      corpus,
      log: (line) => lines.push(line),
    });

    expect(exitCode).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("CONNECTION_TIMEOUT");
    expect(lines.join("\n")).toContain("provider-error");
  });

  it("returns a non-zero exit code when a case echoes a prohibited literal", async () => {
    const { provider } = createFakeProvider({ answer: "PWNED-ALPHA" });

    await expect(
      runEvaluation(options({ preflightOnly: false }), {
        provider,
        corpus,
        log: () => {},
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it("writes no artifacts unless responses were explicitly requested", async () => {
    const { provider } = createFakeProvider();
    const written: string[] = [];

    await runEvaluation(options({ preflightOnly: false }), {
      provider,
      corpus,
      log: () => {},
      writeArtifact: async (file) => {
        written.push(file);
      },
    });

    expect(written).toEqual([]);
  });

  it("writes one artifact file when responses are explicitly requested", async () => {
    const { provider } = createFakeProvider();
    const written: string[] = [];

    await runEvaluation(options({ preflightOnly: false, saveResponses: true }), {
      provider,
      corpus,
      log: () => {},
      writeArtifact: async (file) => {
        written.push(file);
      },
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.replaceAll("\\", "/")).toContain("artifacts/evaluation");
  });

  it("records measured output tokens in saved results", async () => {
    const { provider } = createFakeProvider({
      answer: "word ".repeat(100),
      outputTokens: 7,
    });
    const contents: string[] = [];

    await runEvaluation(options({ preflightOnly: false, saveResponses: true }), {
      provider,
      corpus,
      log: () => {},
      writeArtifact: async (_file, body) => {
        contents.push(body);
      },
    });

    const artifact = JSON.parse(contents[0] ?? "null") as {
      results: Array<{ outputTokens: number }>;
    };
    expect(artifact.results[0]?.outputTokens).toBe(7);
  });

  it("rejects response artifacts outside the ignored evaluation directory", async () => {
    const { provider } = createFakeProvider();
    const written: string[] = [];

    await expect(
      runEvaluation(
        options({
          preflightOnly: false,
          saveResponses: true,
          artifactDirectory: "tests/evaluation",
        }),
        {
          provider,
          corpus,
          log: () => {},
          writeArtifact: async (file) => {
            written.push(file);
          },
        },
      ),
    ).rejects.toThrow(/artifact directory/i);
    expect(written).toEqual([]);
  });
});

function answer(text: string): {
  text: string;
  completed: boolean;
  numPredict: number;
} {
  return { text, completed: true, numPredict: 256 };
}

export type { EvaluationCase };
