import { describe, expect, it } from "vitest";
import type {
  BackgroundPortMessage,
  ReaderPortMessage,
} from "../../platform/messaging/contracts";
import { createReaderConnection, type ReaderBrowserPort } from "./reader-connection";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

class FakeBrowserPort implements ReaderBrowserPort {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  postMessage(_message: ReaderPortMessage): void {}

  onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener);
    },
    removeListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.delete(listener);
    },
  };

  onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: () => void): void => {
      this.disconnectListeners.delete(listener);
    },
  };

  disconnect(): void {}

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

describe("reader content port boundary", () => {
  it("ignores malformed port input before it reaches the controller listener", () => {
    const port = new FakeBrowserPort();
    const received: BackgroundPortMessage[] = [];
    const connection = createReaderConnection(port);
    connection.subscribe((message) => received.push(message));

    expect(() =>
      port.emit({
        type: "stream-event",
        event: { type: "delta", requestId: REQUEST_ID, sequence: -1, text: "bad" },
      }),
    ).not.toThrow();
    port.emit({
      type: "stream-event",
      event: { type: "started", requestId: REQUEST_ID },
    });

    expect(received).toEqual([
      { type: "stream-event", event: { type: "started", requestId: REQUEST_ID } },
    ]);
  });
});
