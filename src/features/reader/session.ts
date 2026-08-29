import type { ReadingAction } from "../../core/requests/types";
import type { PublicErrorShape, StreamEvent } from "../../providers/provider";

export const MAX_SELECTION_PREVIEW_CHARACTERS = 240;
export const MAX_DISPLAY_ANSWER_CHARACTERS = 16_000;

export type ReaderSessionStatus =
  "pending" | "streaming" | "completed" | "cancelled" | "failed";

/** Public, serializable state suitable for rendering in an extension UI. */
export interface ReaderSession {
  tabId: number;
  requestId: string;
  selectionPreview: string;
  action: ReadingAction;
  contextIncluded: boolean;
  status: ReaderSessionStatus;
  answer: string;
  lastSequence: number;
  error?: PublicErrorShape;
  origin: string;
}

/** Trusted background-only request material. Never expose this through the UI session. */
export interface PrivateSourceEnvelope {
  requestId: string;
  selection: string;
  nearbyContext?: string;
  previousAnswer?: string;
  origin: string;
}

export function capDisplayCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function startSession(session: ReaderSession): ReaderSession {
  return {
    tabId: session.tabId,
    requestId: session.requestId,
    selectionPreview: session.selectionPreview,
    action: session.action,
    contextIncluded: session.contextIncluded,
    status: "streaming",
    answer: "",
    lastSequence: -1,
    origin: session.origin,
  };
}

/** Reduce one provider event without mutating public reader state. */
export function reduceReaderSession(
  session: ReaderSession,
  event: StreamEvent,
): ReaderSession {
  if (event.requestId !== session.requestId) return session;

  switch (event.type) {
    case "started":
      return session.status === "pending" ? startSession(session) : session;
    case "delta":
      if (session.status !== "streaming") return session;
      if (event.sequence !== session.lastSequence + 1) return session;
      return {
        ...session,
        status: "streaming",
        answer: capDisplayCharacters(
          `${session.answer}${event.text}`,
          MAX_DISPLAY_ANSWER_CHARACTERS,
        ),
        lastSequence: event.sequence,
      };
    case "completed":
      return session.status === "streaming"
        ? { ...session, status: "completed" }
        : session;
    case "cancelled":
      return session.status === "pending" || session.status === "streaming"
        ? { ...session, status: "cancelled" }
        : session;
    case "failed":
      return session.status === "pending" || session.status === "streaming"
        ? { ...session, status: "failed", error: event.error }
        : session;
  }
}
