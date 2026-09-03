import type { NearbyContext } from "../../core/privacy/context-extractor";
import type { SelectionSnapshot } from "../../core/privacy/selection";
import type { FollowUpIntent, ReadingAction } from "../../core/requests/types";
import type {
  BackgroundPortMessage,
  ReaderPortMessage,
} from "../../platform/messaging/contracts";
import type { ReaderInvocationCommand } from "../../platform/messaging/reader-command";
import type { ReaderRuntimeConfig } from "../../platform/messaging/reader-runtime";
import type { PublicErrorShape, StreamEvent } from "../../providers/provider";
import type { SelectedProvider } from "../settings/settings";
import type { ReaderSession } from "./session";

interface ReaderSurfaceState {
  requestId: string;
  preview: string;
  action: ReadingAction;
  contextIncluded: boolean;
  anchor: SelectionSnapshot;
  /**
   * The provider mode the background reports for this request. Absent until a
   * session-snapshot arrives (or for a record that never carried one), and
   * rendering code must treat that absence as unknown, not local.
   */
  provider?: SelectedProvider;
}

interface ReaderAnswerState extends ReaderSurfaceState {
  answer: string;
}

interface ReaderPreflightFailureState {
  status: "failed";
  preview: string;
  action: ReadingAction;
  contextIncluded: false;
  anchor: SelectionSnapshot;
  answer: "";
  error: PublicErrorShape;
  retryWithoutContext: true;
}

export type ReaderUiState =
  | { status: "idle" }
  | {
      status: "actions";
      selection: SelectionSnapshot;
      config: ReaderRuntimeConfig;
    }
  | ({ status: "connecting" } & ReaderSurfaceState)
  | ({ status: "generating" } & ReaderAnswerState)
  | ({ status: "complete" } & ReaderAnswerState)
  | ({ status: "cancelled" } & ReaderAnswerState)
  | ({ status: "failed"; error: PublicErrorShape } & ReaderAnswerState)
  | ReaderPreflightFailureState;

export interface ReaderConnection {
  send(message: ReaderPortMessage): void;
  subscribe(listener: (message: BackgroundPortMessage) => void): () => void;
  subscribeDisconnect(listener: () => void): () => void;
  disconnect(): void;
}

export interface ReaderControllerDependencies {
  captureSelection(): SelectionSnapshot | undefined;
  getReaderConfig(): Promise<ReaderRuntimeConfig>;
  extractNearbyContext(snapshot: SelectionSnapshot, enabled: boolean): NearbyContext;
  connect(): ReaderConnection;
  createRequestId(): string;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  restoreFocus(snapshot: SelectionSnapshot): void;
  writeClipboard(text: string): Promise<void>;
  openSidePanel(): Promise<void>;
  openOptionsPage(): Promise<void>;
}

interface ActiveRequest {
  requestId: string;
  connection: ReaderConnection;
  disconnected: boolean;
  cancelSent: boolean;
  lastSequence: number;
  deltaBuffer: string;
  frameId: number | undefined;
  unsubscribeMessage: () => void;
  unsubscribeDisconnect: () => void;
}

const DISCONNECTED_ERROR: PublicErrorShape = {
  code: "PROVIDER_ERROR",
  message: "The local connection was interrupted. Retry to continue.",
  recoverable: true,
};

function answerOf(state: ReaderUiState): string {
  return "answer" in state ? state.answer : "";
}

function surfaceOf(state: ReaderUiState): ReaderSurfaceState | undefined {
  if (
    "requestId" in state &&
    (state.status === "connecting" ||
      state.status === "generating" ||
      state.status === "complete" ||
      state.status === "cancelled" ||
      state.status === "failed")
  ) {
    return {
      requestId: state.requestId,
      preview: state.preview,
      action: state.action,
      contextIncluded: state.contextIncluded,
      anchor: state.anchor,
      ...(state.provider === undefined ? {} : { provider: state.provider }),
    };
  }
  return undefined;
}

/**
 * A carried-over surface may still hold a previous request's provider. Used by
 * retry()/followUp() so their optimistic "connecting" state can't assert a
 * locality claim that may no longer match the request just sent — the field is
 * dropped (not set to `undefined`, which `exactOptionalPropertyTypes` forbids
 * for an optional property) until an authoritative session-snapshot arrives.
 */
function withoutProvider(surface: ReaderSurfaceState): ReaderSurfaceState {
  if (!("provider" in surface)) return surface;
  const rest: ReaderSurfaceState = { ...surface };
  delete rest.provider;
  return rest;
}

export class ReaderController {
  private state: ReaderUiState = { status: "idle" };
  private readonly listeners = new Set<() => void>();
  private active: ActiveRequest | undefined;
  private selectionEpoch = 0;

  constructor(private readonly dependencies: ReaderControllerDependencies) {}

  getState = (): ReaderUiState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async selectionCompleted(): Promise<void> {
    const epoch = ++this.selectionEpoch;
    const selection = this.dependencies.captureSelection();
    if (!selection) {
      this.closeFor("collapse");
      return;
    }
    const config = await this.dependencies.getReaderConfig();
    if (epoch !== this.selectionEpoch) return;
    if (!config.automaticToolbar || config.blocked) {
      this.close(false);
      return;
    }
    this.cancelActive();
    this.setState({ status: "actions", selection, config });
  }

  async handleInvocation(command: ReaderInvocationCommand): Promise<void> {
    const epoch = ++this.selectionEpoch;
    const selection = this.dependencies.captureSelection();
    if (!selection) {
      this.close(false);
      return;
    }
    const config = await this.dependencies.getReaderConfig();
    if (epoch !== this.selectionEpoch) return;
    if (config.blocked) {
      this.close(false);
      return;
    }
    const explicitSelection =
      command.type === "selection-action"
        ? { ...selection, text: command.selectionText.trim() }
        : selection;
    if (!explicitSelection.text) {
      this.close(false);
      return;
    }
    this.cancelActive();
    this.setState({ status: "actions", selection: explicitSelection, config });
    this.startAction(command.action);
  }

  startAction(action: ReadingAction): void {
    if (this.state.status !== "actions") return;
    const { selection, config } = this.state;
    let context: NearbyContext;
    try {
      context = this.dependencies.extractNearbyContext(
        selection,
        config.includeNearbyContext,
      );
    } catch (error) {
      this.setState({
        status: "failed",
        preview: selection.text,
        action,
        contextIncluded: false,
        anchor: selection,
        answer: "",
        retryWithoutContext: true,
        error: {
          code: "CONTEXT_TOO_LARGE",
          message:
            error instanceof Error ? error.message : "The nearby context is too large.",
          recoverable: true,
        },
      });
      return;
    }

    this.startRequest(action, selection, context);
  }

  private startRequest(
    action: ReadingAction,
    selection: SelectionSnapshot,
    context: NearbyContext,
  ): void {
    this.cancelActive();
    const requestId = this.dependencies.createRequestId();
    const surface: ReaderSurfaceState = {
      requestId,
      preview: selection.text,
      action,
      contextIncluded: context.text.length > 0,
      anchor: selection,
    };
    this.setState({ status: "connecting", ...surface });
    const connection = this.openConnection(requestId);
    connection.send({
      type: "start-request",
      request: {
        requestId,
        action,
        selection: selection.text,
        ...(context.text.length > 0 ? { nearbyContext: context.text } : {}),
      },
    });
  }

  stop(): void {
    const active = this.active;
    if (!active || active.cancelSent) return;
    if (this.state.status !== "connecting" && this.state.status !== "generating") {
      return;
    }
    active.cancelSent = true;
    active.connection.send({
      type: "cancel-request",
      requestId: active.requestId,
    });
  }

  retry(): boolean {
    if (this.state.status !== "failed" || !this.state.error.recoverable) return false;
    if ("retryWithoutContext" in this.state) {
      this.startRequest(this.state.action, this.state.anchor, {
        text: "",
        estimatedTokens: 0,
        sourceBlockCount: 0,
      });
      return true;
    }
    const surface = surfaceOf(this.state);
    if (!surface || !surface.requestId) return false;
    let active = this.active;
    if (!active || active.disconnected) {
      this.releaseActive();
      const connection = this.openConnection(surface.requestId);
      active = this.active;
      connection.send({ type: "retry-request", requestId: surface.requestId });
    } else {
      active.connection.send({
        type: "retry-request",
        requestId: surface.requestId,
      });
      active.cancelSent = false;
      active.lastSequence = -1;
    }
    // The carried-over surface may still hold the previous request's provider.
    // Preferences can change between requests, so that value is stale until the
    // coordinator's session-snapshot reports the provider actually in effect —
    // render the neutral case, not a possibly-false locality claim, until then.
    this.setState({ status: "connecting", ...withoutProvider(surface) });
    return true;
  }

  followUp(intent: FollowUpIntent): boolean {
    if (this.state.status !== "complete" || !this.active) return false;
    const surface = surfaceOf(this.state);
    if (!surface) return false;
    this.active.lastSequence = -1;
    this.active.cancelSent = false;
    this.active.connection.send({
      type: "follow-up",
      requestId: surface.requestId,
      intent,
    });
    // Same reasoning as retry(): drop the previous request's provider so the
    // optimistic state can't assert a locality claim the new request may not
    // match, until the coordinator's session-snapshot says otherwise.
    this.setState({ status: "connecting", ...withoutProvider(surface) });
    return true;
  }

  async copyAnswer(): Promise<boolean> {
    const answer = answerOf(this.state);
    if (!answer) return false;
    await this.dependencies.writeClipboard(answer);
    return true;
  }

  openSidePanel(): Promise<void> {
    return this.dependencies.openSidePanel();
  }

  openOptionsPage(): Promise<void> {
    return this.dependencies.openOptionsPage();
  }

  closeFor(reason: "escape" | "collapse" | "blur" | "invalidation"): void {
    switch (reason) {
      case "escape":
      case "collapse":
      case "blur":
      case "invalidation":
        this.close(true);
        return;
    }
  }

  contextInvalidated(): void {
    if (this.state.status === "idle") return;
    const current = this.dependencies.captureSelection();
    const anchor =
      this.state.status === "actions"
        ? this.state.selection
        : surfaceOf(this.state)?.anchor;
    if (
      !current ||
      !anchor ||
      current.text !== anchor.text ||
      current.anchorElement !== anchor.anchorElement ||
      current.range.startContainer !== anchor.range.startContainer ||
      current.range.startOffset !== anchor.range.startOffset ||
      current.range.endContainer !== anchor.range.endContainer ||
      current.range.endOffset !== anchor.range.endOffset
    ) {
      this.closeFor("invalidation");
    }
  }

  destroy(): void {
    this.selectionEpoch += 1;
    this.cancelActive();
    this.releaseActive();
    this.setState({ status: "idle" });
  }

  private openConnection(requestId: string): ReaderConnection {
    const connection = this.dependencies.connect();
    const active: ActiveRequest = {
      requestId,
      connection,
      disconnected: false,
      cancelSent: false,
      lastSequence: -1,
      deltaBuffer: "",
      frameId: undefined,
      unsubscribeMessage: () => undefined,
      unsubscribeDisconnect: () => undefined,
    };
    active.unsubscribeMessage = connection.subscribe((message) => {
      if (this.active !== active) return;
      this.receive(message);
    });
    active.unsubscribeDisconnect = connection.subscribeDisconnect(() => {
      if (this.active !== active || active.disconnected) return;
      active.disconnected = true;
      this.flushDeltas(active);
      const surface = surfaceOf(this.state);
      if (!surface) return;
      this.setState({
        status: "failed",
        ...surface,
        answer: answerOf(this.state),
        error: DISCONNECTED_ERROR,
      });
    });
    this.active = active;
    return connection;
  }

  private receive(message: BackgroundPortMessage): void {
    if (message.type === "command-failed") {
      const surface = surfaceOf(this.state);
      if (!surface) return;
      this.setState({
        status: "failed",
        ...surface,
        answer: answerOf(this.state),
        error: message.error,
      });
      return;
    }
    if (message.type === "stream-event") this.receiveEvent(message.event);
    if (message.type === "session-snapshot") {
      this.receiveSessionSnapshot(message.session);
    }
  }

  /**
   * The background locks the provider mode into the session at creation and
   * reports it here. This is the only place the in-page surface learns which
   * mode a request actually runs under — nothing here may fall back to a local
   * assumption for a request whose reported provider is still unknown.
   */
  private receiveSessionSnapshot(session: ReaderSession): void {
    const active = this.active;
    if (!active || session.requestId !== active.requestId) return;
    if (session.provider === undefined) return;
    if (!("requestId" in this.state) || this.state.requestId !== session.requestId) {
      return;
    }
    if (this.state.provider === session.provider) return;
    this.setState({ ...this.state, provider: session.provider });
  }

  private receiveEvent(event: StreamEvent): void {
    const active = this.active;
    const surface = surfaceOf(this.state);
    if (!active || !surface || event.requestId !== active.requestId) return;

    switch (event.type) {
      case "started":
        if (this.state.status !== "connecting") return;
        this.setState({ status: "generating", ...surface, answer: "" });
        return;
      case "delta":
        if (this.state.status !== "generating") return;
        if (event.sequence !== active.lastSequence + 1) return;
        active.lastSequence = event.sequence;
        active.deltaBuffer += event.text;
        if (active.frameId === undefined) {
          active.frameId = this.dependencies.requestFrame(() => {
            active.frameId = undefined;
            this.flushDeltas(active);
          });
        }
        return;
      case "completed":
        if (this.state.status !== "generating") return;
        this.flushDeltas(active);
        this.setState({
          status: "complete",
          ...surface,
          answer: answerOf(this.state),
        });
        return;
      case "cancelled":
        if (this.state.status !== "connecting" && this.state.status !== "generating") {
          return;
        }
        this.flushDeltas(active);
        this.setState({
          status: "cancelled",
          ...surface,
          answer: answerOf(this.state),
        });
        return;
      case "failed":
        if (this.state.status !== "connecting" && this.state.status !== "generating") {
          return;
        }
        this.flushDeltas(active);
        this.setState({
          status: "failed",
          ...surface,
          answer: answerOf(this.state),
          error: event.error,
        });
        return;
    }
  }

  private flushDeltas(active: ActiveRequest): void {
    if (this.active !== active) return;
    if (active.frameId !== undefined) {
      this.dependencies.cancelFrame(active.frameId);
      active.frameId = undefined;
    }
    if (active.deltaBuffer.length === 0) return;
    const surface = surfaceOf(this.state);
    if (!surface) return;
    const answer = `${answerOf(this.state)}${active.deltaBuffer}`;
    active.deltaBuffer = "";
    this.setState({ status: "generating", ...surface, answer });
  }

  private cancelActive(): void {
    const active = this.active;
    if (!active) return;
    if (
      !active.cancelSent &&
      (this.state.status === "connecting" || this.state.status === "generating")
    ) {
      active.cancelSent = true;
      active.connection.send({
        type: "cancel-request",
        requestId: active.requestId,
      });
    }
    this.releaseActive();
  }

  private releaseActive(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    if (active.frameId !== undefined) this.dependencies.cancelFrame(active.frameId);
    active.unsubscribeMessage();
    active.unsubscribeDisconnect();
    active.connection.disconnect();
  }

  private close(restoreFocus: boolean): void {
    this.selectionEpoch += 1;
    const anchor =
      this.state.status === "actions"
        ? this.state.selection
        : surfaceOf(this.state)?.anchor;
    this.cancelActive();
    this.setState({ status: "idle" });
    if (restoreFocus && anchor) this.dependencies.restoreFocus(anchor);
  }

  private setState(state: ReaderUiState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
