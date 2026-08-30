import { z } from "zod";
import { PublicError } from "../../core/requests/public-error";
import type { FollowUpIntent, ReadingAction } from "../../core/requests/types";
import type { ReaderSession } from "../../features/reader/session";
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
