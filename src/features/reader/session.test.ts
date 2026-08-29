import { describe, expect, it } from "vitest";
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
    const afterFirst = reduceReaderSession(session(), {
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
    const result = reduceReaderSession(session(), {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "x".repeat(16_001),
    });

    expect(result.answer).toHaveLength(16_000);
  });

  it("serializes only JSON-safe public session fields", () => {
    const publicSession = session();
    const serialized = JSON.stringify(publicSession);

    expect(JSON.parse(serialized)).toEqual(publicSession);
    expect(serialized).not.toContain("AbortController");
    expect(serialized).not.toContain("private selection");
  });
});
