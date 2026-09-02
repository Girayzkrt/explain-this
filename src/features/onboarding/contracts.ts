import { z } from "zod";
import { PUBLIC_ERROR_CODES, PublicError } from "../../core/requests/public-error";
import {
  ReadingPreferencesSchema,
  type ReadingPreferences,
} from "../settings/settings";
import type {
  ModelDownloadEvent,
  ModelInfo,
  ProviderHealth,
  PublicErrorShape,
} from "../../providers/provider";

export interface ReadinessResult {
  status: "ready" | "warning";
  firstTokenMs: number;
  tokensPerSecond: number;
  warnings: Array<"slow-first-token" | "slow-generation">;
}

export type OnboardingCommand =
  | { type: "check-runtime" }
  | { type: "list-models" }
  | { type: "download-model"; model: string }
  | { type: "cancel-download" }
  | { type: "run-readiness"; model: string; preferences: ReadingPreferences }
  | { type: "complete-onboarding"; preferences: ReadingPreferences };

export type OnboardingEvent =
  | { type: "runtime-result"; health: ProviderHealth }
  | { type: "models-result"; models: ModelInfo[] }
  | { type: "download-progress"; progress: ModelDownloadEvent }
  | { type: "readiness-result"; result: ReadinessResult }
  | { type: "onboarding-complete" }
  | { type: "onboarding-failed"; error: PublicErrorShape };

const PublicErrorCodeSchema = z.enum(PUBLIC_ERROR_CODES);

const PublicErrorShapeSchema = z
  .object({
    code: PublicErrorCodeSchema,
    message: z.string().max(500),
    recoverable: z.boolean(),
  })
  .strict();

const ProviderHealthSchema = z
  .object({
    available: z.boolean(),
    status: z
      .enum(["ready", "model-required", "unreachable", "origin-blocked", "error"])
      .optional(),
    message: z.string().optional(),
    error: PublicErrorShapeSchema.optional(),
    secondaryAction: z.literal("show-origin-guidance").optional(),
  })
  .strict();

const ModelInfoSchema = z
  .object({
    id: z.string().min(1).max(200),
    displayName: z.string().min(1).max(260),
    sizeBytes: z.number().nonnegative().optional(),
    origin: z.enum(["local", "cloud", "unknown"]),
  })
  .strict();

const ModelDownloadEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), model: z.string().min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("progress"),
      model: z.string().min(1).max(200),
      completedBytes: z.number().nonnegative(),
      totalBytes: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("completed"), model: z.string().min(1).max(200) })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      model: z.string().min(1).max(200),
      error: PublicErrorShapeSchema,
    })
    .strict(),
]);

const ReadinessResultSchema = z
  .object({
    status: z.enum(["ready", "warning"]),
    firstTokenMs: z.number().nonnegative(),
    tokensPerSecond: z.number().nonnegative(),
    warnings: z.array(z.enum(["slow-first-token", "slow-generation"])).max(2),
  })
  .strict();

const StrictPreferencesSchema = ReadingPreferencesSchema.strict();
const ModelNameSchema = z.string().min(1).max(200);

export const OnboardingCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("check-runtime") }).strict(),
  z.object({ type: z.literal("list-models") }).strict(),
  z.object({ type: z.literal("download-model"), model: ModelNameSchema }).strict(),
  z.object({ type: z.literal("cancel-download") }).strict(),
  z
    .object({
      type: z.literal("run-readiness"),
      model: ModelNameSchema,
      preferences: StrictPreferencesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("complete-onboarding"),
      preferences: StrictPreferencesSchema,
    })
    .strict(),
]);

export const OnboardingEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("runtime-result"), health: ProviderHealthSchema })
    .strict(),
  z
    .object({ type: z.literal("models-result"), models: z.array(ModelInfoSchema) })
    .strict(),
  z
    .object({
      type: z.literal("download-progress"),
      progress: ModelDownloadEventSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("readiness-result"), result: ReadinessResultSchema })
    .strict(),
  z.object({ type: z.literal("onboarding-complete") }).strict(),
  z
    .object({ type: z.literal("onboarding-failed"), error: PublicErrorShapeSchema })
    .strict(),
]);

export function parseOnboardingCommand(input: unknown): OnboardingCommand {
  const parsed = OnboardingCommandSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublicError(
      "INVALID_REQUEST",
      "The onboarding command was invalid.",
      false,
    );
  }
  return parsed.data as OnboardingCommand;
}

export function parseOnboardingEvent(input: unknown): OnboardingEvent {
  const parsed = OnboardingEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new PublicError(
      "INVALID_REQUEST",
      "The onboarding event was invalid.",
      false,
    );
  }
  return parsed.data as OnboardingEvent;
}
