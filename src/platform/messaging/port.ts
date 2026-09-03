import type { BackgroundPortMessage } from "./contracts";

export interface ListenerSet<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

/** JSON-message-only subset shared by Chrome runtime ports and coordinator tests. */
export interface PortLike<TOutgoing = BackgroundPortMessage> {
  postMessage(message: TOutgoing): void;
  onMessage: ListenerSet<(message: unknown) => void>;
  onDisconnect: ListenerSet<() => void>;
  disconnect(): void;
}

/** Browser-owned metadata. No tab or origin fields are accepted from port messages. */
export interface TrustedPortSender {
  origin?: string;
  url?: string;
  tab?: {
    id?: number;
    url?: string;
  };
}
