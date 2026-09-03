import { z } from "zod";
import { PUBLIC_ERROR_CODES, PublicError } from "../../core/requests/public-error";
import type { FollowUpIntent, ReadingAction } from "../../core/requests/types";
import {
  MAX_DISPLAY_ANSWER_CHARACTERS,
  MAX_SELECTION_PREVIEW_CHARACTERS,
  type ReaderSession,
} from "../../features/reader/session";
import { SelectedProviderSchema } from "../../features/settings/settings";
import type { PublicErrorShape, StreamEvent } from "../../providers/provider";

export interface ReaderStartRequest {
  requestId: string;
  action: ReadingAction;
  selection: string;
  nearbyContext?: string;
}

export type ReaderPortMessage =
  | { type: "start-request"; request: ReaderStartRequest }
  | { type: "cancel-request"; requestId: string }
  | { type: "retry-request"; requestId: string }
  | { type: "follow-up"; requestId: string; intent: FollowUpIntent }
  | { type: "open-side-panel" };

export type BackgroundPortMessage =
  | { type: "stream-event"; event: StreamEvent }
  | { type: "session-snapshot"; session: ReaderSession }
  | { type: "command-failed"; error: PublicErrorShape };

const RequestIdSchema = z.uuid();
const TransportTextSchema = z.string().min(1).max(32_000);
const PublicErrorSchema = z
  .object({
    code: z.enum(PUBLIC_ERROR_CODES),
    message: TransportTextSchema,
    recoverable: z.boolean(),
  })
  .strict();
const StreamMetricsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
  })
  .strict();
const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), requestId: RequestIdSchema }).strict(),
  z
    .object({
      type: z.literal("delta"),
      requestId: RequestIdSchema,
      sequence: z.number().int().nonnegative(),
      text: TransportTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("completed"),
      requestId: RequestIdSchema,
      metrics: StreamMetricsSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("cancelled"), requestId: RequestIdSchema }).strict(),
  z
    .object({
      type: z.literal("failed"),
      requestId: RequestIdSchema,
      error: PublicErrorSchema,
    })
    .strict(),
]);
const ReaderSessionSchema = z
  .object({
    tabId: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
    selectionPreview: z.string().min(1).max(MAX_SELECTION_PREVIEW_CHARACTERS),
    action: z.enum(["explain", "simplify", "translate", "example"]),
    contextIncluded: z.boolean(),
    status: z.enum(["pending", "streaming", "completed", "cancelled", "failed"]),
    answer: z.string().max(MAX_DISPLAY_ANSWER_CHARACTERS),
    lastSequence: z.number().int().min(-1),
    error: PublicErrorSchema.optional(),
    origin: z.url(),
    provider: SelectedProviderSchema.optional(),
  })
  .strict();
const ReaderStartRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    action: z.enum(["explain", "simplify", "translate", "example"]),
    selection: TransportTextSchema,
    nearbyContext: TransportTextSchema.optional(),
  })
  .strict();

/** Commands carrying reading data that are accepted from an injected reader surface. */
const ReaderCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start-request"),
      request: ReaderStartRequestSchema,
    })
    .strict(),
  z.object({ type: z.literal("cancel-request"), requestId: RequestIdSchema }).strict(),
  z.object({ type: z.literal("retry-request"), requestId: RequestIdSchema }).strict(),
  z
    .object({
      type: z.literal("follow-up"),
      requestId: RequestIdSchema,
      intent: z.enum(["simpler", "more-detail", "why", "another-example"]),
    })
    .strict(),
]);

const BackgroundPortMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stream-event"), event: StreamEventSchema }).strict(),
  z
    .object({ type: z.literal("session-snapshot"), session: ReaderSessionSchema })
    .strict(),
  z.object({ type: z.literal("command-failed"), error: PublicErrorSchema }).strict(),
]);

export type ReaderCommandMessage = Exclude<
  ReaderPortMessage,
  { type: "open-side-panel" }
>;

export function parseReaderPortMessage(input: unknown): ReaderCommandMessage {
  const result = ReaderCommandSchema.safeParse(input);
  if (!result.success) {
    throw new PublicError("INVALID_REQUEST", "The reader command was invalid.", false);
  }

  return result.data as ReaderCommandMessage;
}

/** Ignore malformed worker messages before they reach the injected reader UI. */
export function parseBackgroundPortMessage(
  input: unknown,
): BackgroundPortMessage | undefined {
  const result = BackgroundPortMessageSchema.safeParse(input);
  return result.success ? (result.data as BackgroundPortMessage) : undefined;
}

/** Parse the public session record without accepting any source-only fields. */
export function parseReaderSession(input: unknown): ReaderSession | undefined {
  const result = ReaderSessionSchema.safeParse(input);
  return result.success ? (result.data as ReaderSession) : undefined;
}
