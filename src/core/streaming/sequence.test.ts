import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../../providers/provider";
import { acceptStreamEvent, createStreamSequence } from "./sequence";

describe("acceptStreamEvent", () => {
  it("accepts the active lifecycle and contiguous delta events", () => {
    const state = createStreamSequence("request-1");
    const started: StreamEvent = { type: "started", requestId: "request-1" };
    const delta: StreamEvent = {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "hello",
    };

    expect(acceptStreamEvent(state, started)).toEqual({ accepted: true });
    expect(acceptStreamEvent(state, delta)).toEqual({ accepted: true });
    expect(state.lastSequence).toBe(0);
  });

  it("rejects lifecycle events from a stale request", () => {
    const state = createStreamSequence("request-1");
    const event: StreamEvent = { type: "completed", requestId: "request-2" };

    expect(acceptStreamEvent(state, event)).toEqual({
      accepted: false,
      reason: "stale",
    });
  });

  it("rejects a duplicate delta sequence", () => {
    const state = createStreamSequence("request-1");
    const first: StreamEvent = {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "a",
    };
    const duplicate: StreamEvent = {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "again",
    };

    expect(acceptStreamEvent(state, first)).toEqual({ accepted: true });
    expect(acceptStreamEvent(state, duplicate)).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });

  it("rejects descending and skipped delta sequences as out-of-order", () => {
    const state = createStreamSequence("request-1");
    const first: StreamEvent = {
      type: "delta",
      requestId: "request-1",
      sequence: 0,
      text: "a",
    };
    const skipped: StreamEvent = {
      type: "delta",
      requestId: "request-1",
      sequence: 2,
      text: "c",
    };
    const descending: StreamEvent = {
      type: "delta",
      requestId: "request-1",
      sequence: -1,
      text: "before",
    };

    expect(acceptStreamEvent(state, first)).toEqual({ accepted: true });
    expect(acceptStreamEvent(state, skipped)).toEqual({
      accepted: false,
      reason: "out-of-order",
    });
    expect(acceptStreamEvent(state, descending)).toEqual({
      accepted: false,
      reason: "out-of-order",
    });
  });
});
