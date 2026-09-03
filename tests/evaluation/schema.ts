import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { enforceReadingBudget } from "../../src/core/requests/budget";
import { PublicError } from "../../src/core/requests/public-error";
import type { FollowUpIntent, ReadingAction } from "../../src/core/requests/types";
import { ExplanationLevelSchema } from "../../src/features/settings/settings";

/** Reuse the production level enum so the corpus cannot drift from shipped settings. */
export const EXPLANATION_LEVELS = ExplanationLevelSchema.options;

export const READING_ACTIONS = [
  "explain",
  "simplify",
  "translate",
  "example",
] as const satisfies readonly ReadingAction[];

export const FOLLOW_UP_INTENTS = [
  "simpler",
  "more-detail",
  "why",
  "another-example",
] as const satisfies readonly FollowUpIntent[];

export const EVALUATION_CATEGORIES = [
  "everyday",
  "technical",
  "economics-policy",
  "translation",
  "context-ambiguous",
  "cjk",
  "prompt-injection",
] as const;

export const EvaluationCategorySchema = z.enum(EVALUATION_CATEGORIES);
export const ReadingActionSchema = z.enum(READING_ACTIONS);
export const FollowUpIntentSchema = z.enum(FOLLOW_UP_INTENTS);

const BaseEvaluationCaseSchema = z
  .object({
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Case ids are lowercase kebab-case."),
    category: EvaluationCategorySchema,
    action: ReadingActionSchema,
    followUpIntent: FollowUpIntentSchema.optional(),
    selection: z.string().min(1),
    nearbyContext: z.string().min(1).optional(),
    previousAnswer: z.string().min(1).optional(),
    preferredLanguage: z.string().min(2).max(64),
    explanationLevel: ExplanationLevelSchema,
    preserveEnglishTerms: z.boolean(),
    /** What a human reviewer should see in a good answer. Never asserted automatically. */
    expectedProperties: z.array(z.string().min(1)).min(1),
    /** What a human reviewer should reject even when literal checks pass. */
    prohibitedProperties: z.array(z.string().min(1)).min(1),
    /** Literals the model must never emit; the runner fails a case that echoes one. */
    prohibitedLiterals: z.array(z.string().min(1)),
  })
  .strict();

export const EvaluationCaseSchema = BaseEvaluationCaseSchema.superRefine(
  (entry, ctx) => {
    if (entry.followUpIntent !== undefined && entry.previousAnswer === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${entry.id}: a follow-up intent requires a previous answer.`,
      });
    }

    try {
      enforceReadingBudget({
        selection: entry.selection,
        nearbyContext: entry.nearbyContext,
        previousAnswer: entry.previousAnswer,
      });
    } catch (error) {
      if (!(error instanceof PublicError)) throw error;
      ctx.addIssue({ code: "custom", message: `${entry.id}: ${error.code}` });
    }
  },
);

export const EvaluationCorpusSchema = z
  .object({
    version: z.number().int().min(1),
    cases: z.array(EvaluationCaseSchema).min(1),
  })
  .strict()
  .superRefine((corpus, ctx) => {
    const seen = new Set<string>();
    for (const entry of corpus.cases) {
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate case id: ${entry.id}.` });
      }
      seen.add(entry.id);
    }
  });

export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type EvaluationCorpus = z.infer<typeof EvaluationCorpusSchema>;

export const CORPUS_PATH = path.join(import.meta.dirname, "cases.json");

/** Read and validate the corpus at runtime; the schema, not the compiler, is the gate. */
export async function loadEvaluationCorpus(
  file: string = CORPUS_PATH,
): Promise<EvaluationCorpus> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  return EvaluationCorpusSchema.parse(raw);
}
