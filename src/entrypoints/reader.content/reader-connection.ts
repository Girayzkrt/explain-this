import {
  parseBackgroundPortMessage,
  type ReaderPortMessage,
} from "../../platform/messaging/contracts";
import type { ReaderConnection } from "../../features/reader/reader-controller";

export interface ReaderBrowserPort {
  postMessage(message: ReaderPortMessage): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
  disconnect(): void;
}

export function createReaderConnection(port: ReaderBrowserPort): ReaderConnection {
  return {
    send(message) {
      port.postMessage(message);
    },
    subscribe(listener) {
      const wrapped = (input: unknown): void => {
        const message = parseBackgroundPortMessage(input);
        if (message) listener(message);
      };
      port.onMessage.addListener(wrapped);
      return () => port.onMessage.removeListener(wrapped);
    },
    subscribeDisconnect(listener) {
      port.onDisconnect.addListener(listener);
      return () => port.onDisconnect.removeListener(listener);
    },
    disconnect() {
      port.disconnect();
    },
  };
}
