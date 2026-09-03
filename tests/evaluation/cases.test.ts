// @vitest-environment node

import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/requests/token-estimator";
import {
  EvaluationCorpusSchema,
  loadEvaluationCorpus,
  READING_ACTIONS,
  FOLLOW_UP_INTENTS,
  EXPLANATION_LEVELS,
  type EvaluationCase,
} from "./schema";

const corpus = await loadEvaluationCorpus();

function inCategory(category: EvaluationCase["category"]): EvaluationCase[] {
  return corpus.cases.filter((entry) => entry.category === category);
}

describe("evaluation corpus", () => {
  it("is a versioned corpus that satisfies its own schema", () => {
    expect(EvaluationCorpusSchema.safeParse(corpus).success).toBe(true);
    expect(corpus.version).toBeGreaterThanOrEqual(1);
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  it("gives every case a unique stable identifier", () => {
    const ids = corpus.cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["everyday", 4],
    ["technical", 4],
    ["economics-policy", 2],
    ["translation", 4],
    ["context-ambiguous", 2],
    ["cjk", 2],
    ["prompt-injection", 4],
  ] as const)("covers at least %i %s cases", (category, minimum) => {
    expect(inCategory(category).length).toBeGreaterThanOrEqual(minimum);
  });

  it("exercises every explanation level", () => {
    const levels = new Set(corpus.cases.map((entry) => entry.explanationLevel));
    expect([...levels].sort()).toEqual([...EXPLANATION_LEVELS].sort());
  });

  it("exercises every primary reading action", () => {
    const actions = new Set(corpus.cases.map((entry) => entry.action));
    expect([...actions].sort()).toEqual([...READING_ACTIONS].sort());
  });

  it("exercises every follow-up intent with a prior answer", () => {
    const followUps = corpus.cases.filter(
      (entry) => entry.followUpIntent !== undefined,
    );
    const intents = new Set(followUps.map((entry) => entry.followUpIntent));

    expect([...intents].sort()).toEqual([...FOLLOW_UP_INTENTS].sort());
    for (const entry of followUps) {
      expect(entry.previousAnswer, `${entry.id} needs a prior answer`).toBeDefined();
    }
  });

  it("translates into at least four distinct target languages", () => {
    const languages = new Set(
      inCategory("translation").map((entry) => entry.preferredLanguage),
    );
    expect(languages.size).toBeGreaterThanOrEqual(4);
  });

  it("gives every context-helpful case the nearby context it depends on", () => {
    const ambiguous = inCategory("context-ambiguous");
    for (const entry of ambiguous) {
      expect(entry.nearbyContext, `${entry.id} needs nearby context`).toBeDefined();
    }
  });

  it("uses genuinely dense script in every CJK case", () => {
    const dense = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    for (const entry of inCategory("cjk")) {
      expect(dense.test(entry.selection), `${entry.id} is not dense script`).toBe(true);
    }
  });

  it("gives every prompt-injection case a literal the model must never echo", () => {
    for (const entry of inCategory("prompt-injection")) {
      expect(
        entry.prohibitedLiterals.length,
        `${entry.id} needs a prohibited literal`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every case inside the approved production request budgets", () => {
    for (const entry of corpus.cases) {
      expect(estimateTokens(entry.selection), entry.id).toBeLessThanOrEqual(1_600);
      if (entry.nearbyContext !== undefined) {
        expect(estimateTokens(entry.nearbyContext), entry.id).toBeLessThanOrEqual(400);
      }
      if (entry.previousAnswer !== undefined) {
        expect(estimateTokens(entry.previousAnswer), entry.id).toBeLessThanOrEqual(600);
      }
    }
  });

  it("states what a human reviewer should look for in every case", () => {
    for (const entry of corpus.cases) {
      expect(entry.expectedProperties.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("states what a human reviewer must reject in every case", () => {
    for (const entry of corpus.cases) {
      expect(entry.prohibitedProperties.length, entry.id).toBeGreaterThan(0);
    }
  });
});

describe("evaluation corpus schema", () => {
  it("rejects a case whose selection exceeds the production selection budget", () => {
    const oversized = {
      version: 1,
      cases: [
        {
          ...corpus.cases[0],
          id: "oversized-case",
          selection: "漢".repeat(1_601),
        },
      ],
    };

    expect(EvaluationCorpusSchema.safeParse(oversized).success).toBe(false);
  });

  it("rejects duplicate case identifiers", () => {
    const duplicated = {
      version: 1,
      cases: [corpus.cases[0], corpus.cases[0]],
    };

    expect(EvaluationCorpusSchema.safeParse(duplicated).success).toBe(false);
  });

  it("rejects a follow-up intent without a prior answer", () => {
    const orphaned = {
      version: 1,
      cases: [
        {
          ...corpus.cases[0],
          id: "orphaned-follow-up",
          followUpIntent: "simpler",
          previousAnswer: undefined,
        },
      ],
    };

    expect(EvaluationCorpusSchema.safeParse(orphaned).success).toBe(false);
  });

  it("rejects unknown fields at both corpus boundaries", () => {
    expect(
      EvaluationCorpusSchema.safeParse({
        ...corpus,
        sourceUrl: "https://private.example/history",
      }).success,
    ).toBe(false);

    expect(
      EvaluationCorpusSchema.safeParse({
        version: corpus.version,
        cases: [
          {
            ...corpus.cases[0],
            privateNote: "must never be silently accepted",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires explicit human rejection criteria", () => {
    const caseWithoutRejectionCriteria = { ...corpus.cases[0] } as Record<
      string,
      unknown
    >;
    delete caseWithoutRejectionCriteria.prohibitedProperties;

    expect(
      EvaluationCorpusSchema.safeParse({
        version: corpus.version,
        cases: [caseWithoutRejectionCriteria],
      }).success,
    ).toBe(false);
  });
});
