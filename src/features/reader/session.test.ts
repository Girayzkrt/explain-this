import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../providers/provider";
import type { ReaderSession } from "./session";
import { reduceReaderSession } from "./session";

const session = (): ReaderSession => ({
  tabId: 23,
  requestId: "request-1",
  selectionPreview: "A public preview",
  action: "explain",
  contextIncluded: true,
  status: "pending",
  answer: "",
  lastSequence: -1,
  origin: "https://example.test",
});

describe("reduceReaderSession", () => {
  it("reduces the active stream lifecycle into a safe reader session", () => {
    const initial = Object.freeze({
      ...session(),
      answer: "old answer",
      error: {
        code: "PROVIDER_ERROR" as const,
        message: "old error",
        recoverable: true,
      },
    });
    const started = reduceReaderSession(initial, {
      type: "started",
      requestId: "request-1",
    });
    const delta = reduceReaderSession(started, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "First answer.",
    });
    const completed = reduceReaderSession(delta, {
      type: "completed",
      requestId: "request-1",
    });

    expect(completed).toMatchObject({
      status: "completed",
      answer: "First answer.",
      lastSequence: 0,
    });
    expect(initial).toMatchObject({ status: "pending", answer: "old answer" });
    expect(started).not.toHaveProperty("error");
  });

  it("reduces cancelled and failed terminal events", () => {
    expect(
      reduceReaderSession(session(), {
        type: "cancelled",
        requestId: "request-1",
      }),
    ).toMatchObject({ status: "cancelled" });
    expect(
      reduceReaderSession(session(), {
        type: "failed",
        requestId: "request-1",
        error: {
          code: "PROVIDER_ERROR",
          message: "The model failed.",
          recoverable: true,
        },
      }),
    ).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_ERROR" },
    });
  });

  it("leaves accumulated text unchanged for stale and duplicate deltas", () => {
    const started = reduceReaderSession(session(), {
      type: "started",
      requestId: "request-1",
    });
    const afterFirst = reduceReaderSession(started, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "accepted",
    });
    const duplicate = reduceReaderSession(afterFirst, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: " duplicate",
    });
    const stale = reduceReaderSession(afterFirst, {
      type: "delta",
      requestId: "request-2",
      sequence: 1,
      text: " stale",
    });
    const outOfOrder = reduceReaderSession(afterFirst, {
      type: "delta",
      requestId: "request-1",
      sequence: 2,
      text: " out of order",
    });

    expect(duplicate).toBe(afterFirst);
    expect(stale).toBe(afterFirst);
    expect(outOfOrder).toBe(afterFirst);
    expect(afterFirst.answer).toBe("accepted");
  });

  it("caps display output at the defensive character ceiling", () => {
    const started = reduceReaderSession(session(), {
      type: "started",
      requestId: "request-1",
    });
    const result = reduceReaderSession(started, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "x".repeat(16_001),
    });

    expect(result.answer).toHaveLength(16_000);
  });

  it("does not reset an active answer for duplicate or stale started events", () => {
    const started = reduceReaderSession(session(), {
      type: "started",
      requestId: "request-1",
    });
    const active = reduceReaderSession(started, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "keep this answer",
    });

    expect(
      reduceReaderSession(active, {
        type: "started",
        requestId: "request-1",
      }),
    ).toBe(active);
    expect(
      reduceReaderSession(active, {
        type: "started",
        requestId: "stale-request",
      }),
    ).toBe(active);
  });

  it("does not reopen terminal sessions when later deltas arrive", () => {
    const started = reduceReaderSession(session(), {
      type: "started",
      requestId: "request-1",
    });
    const active = reduceReaderSession(started, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "finished answer",
    });
    const terminalEvents: StreamEvent[] = [
      { type: "completed", requestId: "request-1" },
      { type: "cancelled", requestId: "request-1" },
      {
        type: "failed",
        requestId: "request-1",
        error: {
          code: "PROVIDER_ERROR",
          message: "The model failed.",
          recoverable: true,
        },
      },
    ];

    for (const terminalEvent of terminalEvents) {
      const terminal = reduceReaderSession(active, terminalEvent);
      expect(
        reduceReaderSession(terminal, {
          type: "delta",
          requestId: "request-1",
          sequence: 1,
          text: " must be ignored",
        }),
      ).toBe(terminal);
    }
  });

  it("accepts lifecycle events only from valid states", () => {
    const pending = session();
    expect(
      reduceReaderSession(pending, {
        type: "delta",
        requestId: "request-1",
        sequence: 0,
        text: "too early",
      }),
    ).toBe(pending);
    expect(
      reduceReaderSession(pending, {
        type: "completed",
        requestId: "request-1",
      }),
    ).toBe(pending);

    const failed = reduceReaderSession(pending, {
      type: "failed",
      requestId: "request-1",
      error: {
        code: "PROVIDER_ERROR",
        message: "The model failed before streaming.",
        recoverable: true,
      },
    });
    expect(failed.status).toBe("failed");
    expect(
      reduceReaderSession(failed, {
        type: "started",
        requestId: "request-1",
      }),
    ).toBe(failed);
  });

  it.each([
    { type: "started", requestId: "stale-request" },
    {
      type: "delta",
      requestId: "stale-request",
      sequence: 0,
      text: "stale",
    },
    { type: "completed", requestId: "stale-request" },
    { type: "cancelled", requestId: "stale-request" },
    {
      type: "failed",
      requestId: "stale-request",
      error: {
        code: "PROVIDER_ERROR" as const,
        message: "stale",
        recoverable: true,
      },
    },
  ] satisfies StreamEvent[])(
    "does not mutate for stale $type lifecycle events",
    (event) => {
      const current = session();
      expect(reduceReaderSession(current, event)).toBe(current);
    },
  );

  it("preserves an optional provider field across the streaming lifecycle", () => {
    const initial: ReaderSession = { ...session(), provider: "ollama-cloud" };

    const started = reduceReaderSession(initial, {
      type: "started",
      requestId: "request-1",
    });
    expect(started.provider).toBe("ollama-cloud");

    const delta = reduceReaderSession(started, {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "answer",
    });
    expect(delta.provider).toBe("ollama-cloud");

    const completed = reduceReaderSession(delta, {
      type: "completed",
      requestId: "request-1",
    });
    expect(completed.provider).toBe("ollama-cloud");
  });

  it("leaves the provider field absent when the session never carried one", () => {
    const started = reduceReaderSession(session(), {
      type: "started",
      requestId: "request-1",
    });

    expect(started.provider).toBeUndefined();
    expect(session().provider).toBeUndefined();
  });

  it("serializes only JSON-safe public session fields", () => {
    const publicSession = session();
    const serialized = JSON.stringify(publicSession);

    expect(JSON.parse(serialized)).toEqual(publicSession);
    expect(serialized).not.toContain("AbortController");
    expect(serialized).not.toContain("private selection");
  });
});
