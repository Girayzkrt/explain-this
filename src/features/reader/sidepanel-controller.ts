import type { FollowUpIntent } from "../../core/requests/types";
import {
  parseBackgroundPortMessage,
  type ReaderPortMessage,
} from "../../platform/messaging/contracts";
import type { PortLike } from "../../platform/messaging/port";
import type { PublicErrorShape } from "../../providers/provider";
import type { ReaderSession } from "./session";

const EXPIRED_SOURCE_ERROR: PublicErrorShape = {
  code: "INVALID_REQUEST",
  message:
    "This explanation’s source is no longer available. Select the passage again to continue.",
  recoverable: false,
};

const ACTION_TRANSPORT_ERROR: PublicErrorShape = {
  code: "PROVIDER_ERROR",
  message: "The side panel connection was interrupted. Try the action again.",
  recoverable: true,
};

export type SidePanelState =
  | { status: "loading" }
  | { status: "empty" }
  | {
      status: "session";
      session: ReaderSession;
      actionError?: PublicErrorShape;
    };

export interface SidePanelDependencies {
  getActiveTabId(): Promise<number | undefined>;
  getReaderSession(tabId: number): Promise<ReaderSession | undefined>;
  subscribeToSessionChanges(listener: () => void): () => void;
  subscribeToActiveTabChanges(listener: () => void): () => void;
  connectReaderPort(): PortLike<ReaderPortMessage>;
}

export interface SidePanelController {
  getSnapshot(): SidePanelState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  stop(): void;
  retry(): void;
  followUp(intent: FollowUpIntent): void;
  dispose(): void;
}

interface ActivePort {
  tabId: number;
  port: PortLike<ReaderPortMessage>;
  removeMessageListener(): void;
  removeDisconnectListener(): void;
}

class CurrentTabSidePanelController implements SidePanelController {
  private state: SidePanelState = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  private unsubscribeSessionChanges: (() => void) | undefined;
  private unsubscribeTabChanges: (() => void) | undefined;
  private activeTabId: number | undefined;
  private activePort: ActivePort | undefined;
  private refreshEpoch = 0;
  private displayedSessionEpoch = 0;
  private loaded = false;
  private disposed = false;

  constructor(private readonly dependencies: SidePanelDependencies) {}

  getSnapshot = (): SidePanelState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async load(): Promise<void> {
    if (this.disposed) return;
    if (!this.loaded) {
      this.loaded = true;
      this.unsubscribeSessionChanges = this.dependencies.subscribeToSessionChanges(
        () => {
          void this.refresh();
        },
      );
      this.unsubscribeTabChanges = this.dependencies.subscribeToActiveTabChanges(() => {
        this.beginActiveTabTransition();
        void this.refresh();
      });
    }
    await this.refresh();
  }

  stop(): void {
    const session = this.currentSession();
    if (!session || (session.status !== "pending" && session.status !== "streaming")) {
      return;
    }
    this.send(session, { type: "cancel-request", requestId: session.requestId });
  }

  retry(): void {
    const session = this.currentSession();
    if (!session || (session.status !== "cancelled" && session.status !== "failed")) {
      return;
    }
    this.send(session, { type: "retry-request", requestId: session.requestId });
  }

  followUp(intent: FollowUpIntent): void {
    const session = this.currentSession();
    if (!session || session.status !== "completed") return;
    this.send(session, { type: "follow-up", requestId: session.requestId, intent });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshEpoch += 1;
    this.unsubscribeSessionChanges?.();
    this.unsubscribeTabChanges?.();
    this.unsubscribeSessionChanges = undefined;
    this.unsubscribeTabChanges = undefined;
    this.disconnectPort();
    this.listeners.clear();
  }

  private currentSession(): ReaderSession | undefined {
    return this.state.status === "session" ? this.state.session : undefined;
  }

  private beginActiveTabTransition(): void {
    this.refreshEpoch += 1;
    this.displayedSessionEpoch = 0;
    this.activeTabId = undefined;
    this.disconnectPort();
    this.setState({ status: "loading" });
  }

  private async refresh(): Promise<void> {
    const epoch = ++this.refreshEpoch;
    let tabId: number | undefined;
    try {
      tabId = await this.dependencies.getActiveTabId();
    } catch {
      if (!this.disposed && epoch === this.refreshEpoch) {
        this.disconnectPort();
        this.activeTabId = undefined;
        this.displayedSessionEpoch = 0;
        this.setState({ status: "empty" });
      }
      return;
    }
    if (this.disposed || epoch !== this.refreshEpoch) return;

    const validTabId =
      Number.isInteger(tabId) && (tabId ?? -1) >= 0 ? tabId : undefined;
    if (validTabId !== this.activeTabId) {
      this.disconnectPort();
    }
    this.activeTabId = validTabId;
    if (validTabId === undefined) {
      this.displayedSessionEpoch = 0;
      this.setState({ status: "empty" });
      return;
    }

    let session: ReaderSession | undefined;
    try {
      session = await this.dependencies.getReaderSession(validTabId);
    } catch {
      if (!this.disposed && epoch === this.refreshEpoch) {
        this.displayedSessionEpoch = 0;
        this.setState({ status: "empty" });
      }
      return;
    }
    if (this.disposed || epoch !== this.refreshEpoch) return;
    this.displayedSessionEpoch = session ? epoch : 0;
    this.setState(session ? { status: "session", session } : { status: "empty" });
  }

  private send(session: ReaderSession, message: ReaderPortMessage): void {
    const tabId = this.activeTabId;
    if (
      tabId === undefined ||
      this.disposed ||
      session.tabId !== tabId ||
      this.displayedSessionEpoch !== this.refreshEpoch
    ) {
      return;
    }
    const port = this.ensurePort(tabId);
    try {
      port.postMessage(message);
      this.clearActionError();
    } catch {
      this.disconnectPort();
      try {
        const replacement = this.ensurePort(tabId);
        replacement.postMessage(message);
        this.clearActionError();
      } catch {
        this.disconnectPort();
        this.setActionError(ACTION_TRANSPORT_ERROR);
      }
    }
  }

  private clearActionError(): void {
    const session = this.currentSession();
    if (session && this.state.status === "session" && this.state.actionError) {
      this.setState({ status: "session", session });
    }
  }

  private setActionError(actionError: PublicErrorShape): void {
    const session = this.currentSession();
    if (session) this.setState({ status: "session", session, actionError });
  }

  private ensurePort(tabId: number): PortLike<ReaderPortMessage> {
    if (this.activePort?.tabId === tabId) return this.activePort.port;
    this.disconnectPort();
    const port = this.dependencies.connectReaderPort();
    const onMessage = (input: unknown): void => {
      if (this.activePort?.port !== port) return;
      const message = parseBackgroundPortMessage(input);
      if (!message) return;
      if (message.type === "command-failed") {
        const session = this.currentSession();
        if (!session) return;
        this.setState({
          status: "session",
          session,
          actionError:
            message.error.code === "INVALID_REQUEST"
              ? EXPIRED_SOURCE_ERROR
              : message.error,
        });
        return;
      }
      if (
        message.type === "session-snapshot" &&
        message.session.tabId === this.activeTabId
      ) {
        this.setState({ status: "session", session: message.session });
      }
    };
    const onDisconnect = (): void => this.releasePort(port);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    this.activePort = {
      tabId,
      port,
      removeMessageListener: () => port.onMessage.removeListener(onMessage),
      removeDisconnectListener: () => port.onDisconnect.removeListener(onDisconnect),
    };
    return port;
  }

  private releasePort(port: PortLike<ReaderPortMessage>): void {
    if (this.activePort?.port !== port) return;
    const active = this.activePort;
    this.activePort = undefined;
    active.removeMessageListener();
    active.removeDisconnectListener();
  }

  private disconnectPort(): void {
    const active = this.activePort;
    if (!active) return;
    this.releasePort(active.port);
    active.port.disconnect();
  }

  private setState(state: SidePanelState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export function createSidePanelController(
  dependencies: SidePanelDependencies,
): SidePanelController {
  return new CurrentTabSidePanelController(dependencies);
}
