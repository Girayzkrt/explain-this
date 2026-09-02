import { z } from "zod";
import { enforceReadingBudget } from "../../core/requests/budget";
import { PUBLIC_ERROR_CODES } from "../../core/requests/public-error";
import {
  capDisplayCharacters,
  MAX_DISPLAY_ANSWER_CHARACTERS,
  MAX_SELECTION_PREVIEW_CHARACTERS,
  type PrivateSourceEnvelope,
  type ReaderSession,
} from "../../features/reader/session";
import type { StorageAreaLike } from "./storage-area";

const PublicErrorSchema = z
  .object({
    code: z.enum(PUBLIC_ERROR_CODES),
    message: z.string(),
    recoverable: z.boolean(),
  })
  .strict();

const ReaderSessionSchema = z.object({
  tabId: z.number().int().nonnegative(),
  requestId: z.string().min(1),
  selectionPreview: z
    .string()
    .transform((value) =>
      capDisplayCharacters(value, MAX_SELECTION_PREVIEW_CHARACTERS),
    ),
  action: z.enum(["explain", "simplify", "translate", "example"]),
  contextIncluded: z.boolean(),
  status: z.enum(["pending", "streaming", "completed", "cancelled", "failed"]),
  answer: z
    .string()
    .transform((value) => capDisplayCharacters(value, MAX_DISPLAY_ANSWER_CHARACTERS)),
  lastSequence: z.number().int().min(-1),
  error: PublicErrorSchema.optional(),
  origin: z.string().min(1),
});

const PrivateSourceEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  selection: z.string().min(1),
  nearbyContext: z.string().optional(),
  previousAnswer: z.string().optional(),
  origin: z.string().min(1),
});

export interface SessionRepository {
  getReaderSession(tabId: number): Promise<ReaderSession | undefined>;
  putReaderSession(session: ReaderSession): Promise<void>;
  getPrivateSource(tabId: number): Promise<PrivateSourceEnvelope | undefined>;
  putPrivateSource(tabId: number, source: PrivateSourceEnvelope): Promise<void>;
  removeTabState(tabId: number): Promise<void>;
}

function tabKey(tabId: number, prefix: "reader-session" | "reader-source"): string {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new TypeError("A reader session requires a non-negative numeric tab ID.");
  }
  return `${prefix}:${tabId}`;
}

function toReaderSession(value: z.output<typeof ReaderSessionSchema>): ReaderSession {
  const session: ReaderSession = {
    tabId: value.tabId,
    requestId: value.requestId,
    selectionPreview: value.selectionPreview,
    action: value.action,
    contextIncluded: value.contextIncluded,
    status: value.status,
    answer: value.answer,
    lastSequence: value.lastSequence,
    origin: value.origin,
  };
  if (value.error !== undefined) session.error = value.error;
  return session;
}

function toPrivateSourceEnvelope(
  value: z.output<typeof PrivateSourceEnvelopeSchema>,
): PrivateSourceEnvelope {
  const source: PrivateSourceEnvelope = {
    requestId: value.requestId,
    selection: value.selection,
    origin: value.origin,
  };
  if (value.nearbyContext !== undefined) {
    source.nearbyContext = value.nearbyContext;
  }
  if (value.previousAnswer !== undefined) {
    source.previousAnswer = value.previousAnswer;
  }
  return source;
}

class TemporarySessionRepository implements SessionRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  async getReaderSession(tabId: number): Promise<ReaderSession | undefined> {
    const key = tabKey(tabId, "reader-session");
    const record = await this.storage.get(key);
    const parsed = ReaderSessionSchema.safeParse(record[key]);
    return parsed.success ? toReaderSession(parsed.data) : undefined;
  }

  async putReaderSession(session: ReaderSession): Promise<void> {
    const publicSession = toReaderSession(ReaderSessionSchema.parse(session));
    await this.clearIncoherentState(publicSession.tabId, publicSession);

    await this.storage.set({
      [tabKey(publicSession.tabId, "reader-session")]: publicSession,
    });
  }

  async getPrivateSource(tabId: number): Promise<PrivateSourceEnvelope | undefined> {
    const key = tabKey(tabId, "reader-source");
    const record = await this.storage.get(key);
    const parsed = PrivateSourceEnvelopeSchema.safeParse(record[key]);
    return parsed.success ? toPrivateSourceEnvelope(parsed.data) : undefined;
  }

  async putPrivateSource(tabId: number, source: PrivateSourceEnvelope): Promise<void> {
    const privateSource = toPrivateSourceEnvelope(
      PrivateSourceEnvelopeSchema.parse(source),
    );
    enforceReadingBudget(privateSource);
    await this.clearIncoherentState(tabId, privateSource);
    await this.storage.set({
      [tabKey(tabId, "reader-source")]: privateSource,
    });
  }

  async removeTabState(tabId: number): Promise<void> {
    await this.storage.remove([
      tabKey(tabId, "reader-session"),
      tabKey(tabId, "reader-source"),
    ]);
  }

  private async clearIncoherentState(
    tabId: number,
    next: Pick<ReaderSession, "origin" | "requestId">,
  ): Promise<void> {
    const [session, source] = await Promise.all([
      this.getReaderSession(tabId),
      this.getPrivateSource(tabId),
    ]);
    const records = [session, source].filter(
      (record): record is ReaderSession | PrivateSourceEnvelope => record !== undefined,
    );
    const hasDifferentIdentity = records.some(
      (record) => record.origin !== next.origin || record.requestId !== next.requestId,
    );

    if (hasDifferentIdentity) await this.removeTabState(tabId);
  }
}

export function createSessionRepository(storage: StorageAreaLike): SessionRepository {
  return new TemporarySessionRepository(storage);
}
