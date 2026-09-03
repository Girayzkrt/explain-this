import type { StreamEvent } from "../../providers/provider";

export interface StreamSequence {
  activeRequestId: string;
  lastSequence: number;
}

export type StreamEventAcceptance =
  | { accepted: true }
  | { accepted: false; reason: "stale" | "duplicate" | "out-of-order" };

export function createStreamSequence(activeRequestId: string): StreamSequence {
  return { activeRequestId, lastSequence: -1 };
}

/** Accept only events belonging to this request and contiguous text deltas. */
export function acceptStreamEvent(
  state: StreamSequence,
  event: StreamEvent,
): StreamEventAcceptance {
  if (event.requestId !== state.activeRequestId) {
    return { accepted: false, reason: "stale" };
  }

  if (event.type !== "delta") return { accepted: true };

  if (event.sequence === state.lastSequence) {
    return { accepted: false, reason: "duplicate" };
  }
  if (event.sequence !== state.lastSequence + 1) {
    return { accepted: false, reason: "out-of-order" };
  }

  state.lastSequence = event.sequence;
  return { accepted: true };
}
