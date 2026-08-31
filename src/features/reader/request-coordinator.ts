import { buildChatRequest } from "../../core/prompts/prompt-builder";
import { enforceReadingBudget } from "../../core/requests/budget";
import { PublicError } from "../../core/requests/public-error";
import { ModelConcurrencyGate } from "../../core/requests/model-concurrency-gate";
import { validateReadingRequest } from "../../core/requests/schemas";
import type { FollowUpIntent, ReadingRequest } from "../../core/requests/types";
import { acceptStreamEvent, createStreamSequence } from "../../core/streaming/sequence";
import {
  parseReaderPortMessage,
  type BackgroundPortMessage,
  type ReaderCommandMessage,
  type ReaderStartRequest,
} from "../../platform/messaging/contracts";
import type { PortLike, TrustedPortSender } from "../../platform/messaging/port";
import type { SessionRepository } from "../../platform/storage/session-repository";
import type { SettingsRepository } from "../../platform/storage/settings-repository";
import type {
  LlmProvider,
  PublicErrorShape,
  StreamEvent,
} from "../../providers/provider";
import {
  capDisplayCharacters,
  MAX_SELECTION_PREVIEW_CHARACTERS,
  reduceReaderSession,
  type PrivateSourceEnvelope,
  type ReaderSession,
} from "./session";

export interface RequestCoordinatorDependencies {
  provider: LlmProvider;
  sessionRepository: SessionRepository;
  settingsRepository: SettingsRepository;
  modelGate?: ModelConcurrencyGate;
}

interface TrustedReaderIdentity {
  tabId: number;
  origin: string;
}

interface PortContext extends TrustedReaderIdentity {
  port: PortLike;
  disconnected: boolean;
  epoch: number;
  allowTabCancellation: boolean;
}

interface ActiveGeneration extends TrustedReaderIdentity {
  requestId: string;
  port: PortLike;
  controller: AbortController;
}

interface TabOwnership extends TrustedReaderIdentity {
  requestId: string;
  port: PortLike;
  epoch: number;
}

const INVALID_SENDER = new PublicError(
  "INVALID_REQUEST",
  "The reader connection was invalid.",
  false,
);

function publicError(error: unknown): PublicErrorShape {
  if (error instanceof PublicError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
    };
  }

  return {
    code: "PROVIDER_ERROR",
    message: "The local model provider failed.",
    recoverable: true,
  };
}

function trustedIdentity(sender: TrustedPortSender): TrustedReaderIdentity {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || (tabId ?? -1) < 0) throw INVALID_SENDER;

  const candidate = sender.origin ?? sender.url ?? sender.tab?.url;
  if (!candidate) throw INVALID_SENDER;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw INVALID_SENDER;
    return { tabId: tabId as number, origin: url.origin };
  } catch {
    throw INVALID_SENDER;
  }
}

function withOptionalSource(
  base: ReadingRequest,
  source: PrivateSourceEnvelope,
  includeNearbyContext: boolean,
): ReadingRequest {
  const request = { ...base };
  if (includeNearbyContext && source.nearbyContext !== undefined) {
    request.nearbyContext = source.nearbyContext;
  }
  return request;
}

export class RequestCoordinator {
  private active: ActiveGeneration | undefined;
  private readonly tabOwnership = new Map<number, TabOwnership>();
  private nextEpoch = 0;
  private commandQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();

  private readonly modelGate: ModelConcurrencyGate;

  constructor(private readonly dependencies: RequestCoordinatorDependencies) {
    this.modelGate = dependencies.modelGate ?? new ModelConcurrencyGate();
  }

  handle(port: PortLike, sender: TrustedPortSender): void {
    this.bind(port, sender, false);
  }

  /** Called only after the background validates and binds the extension side panel. */
  handleSidePanel(port: PortLike, sender: TrustedPortSender): void {
    this.bind(port, sender, true);
  }

  private bind(
    port: PortLike,
    sender: TrustedPortSender,
    allowTabCancellation: boolean,
  ): void {
    let identity: TrustedReaderIdentity;
    try {
      identity = trustedIdentity(sender);
    } catch (error) {
      this.post(port, { type: "command-failed", error: publicError(error) });
      return;
    }

    const context: PortContext = {
      ...identity,
      port,
      disconnected: false,
      epoch: ++this.nextEpoch,
      allowTabCancellation,
    };
    const onMessage = (input: unknown): void => {
      let message: ReaderCommandMessage;
      try {
        message = parseReaderPortMessage(input);
      } catch (error) {
        this.post(port, { type: "command-failed", error: publicError(error) });
        return;
      }

      this.enqueueCommand(async () => {
        try {
          await this.handleCommand(context, message);
        } catch (error) {
          if (!context.disconnected) {
            this.post(port, { type: "command-failed", error: publicError(error) });
          }
        }
      });
    };
    const onDisconnect = (): void => {
      if (context.disconnected) return;
      context.disconnected = true;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      const owner = this.tabOwnership.get(context.tabId);
      if (owner?.epoch === context.epoch) {
        this.tabOwnership.delete(context.tabId);
        if (this.active?.port === port) {
          const active = this.active;
          this.active = undefined;
          active.controller.abort();
        }
        void this.removeStoredIdentity(owner);
      }
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  cancelForTab(tabId: number): Promise<void> {
    if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
    if (this.active?.tabId === tabId) {
      const active = this.active;
      this.active = undefined;
      active.controller.abort();
    }
    this.tabOwnership.delete(tabId);
    return this.removeTabState(tabId);
  }

  private async handleCommand(
    context: PortContext,
    message: ReaderCommandMessage,
  ): Promise<void> {
    if (context.disconnected) return;

    switch (message.type) {
      case "start-request":
        await this.start(context, message.request);
        return;
      case "cancel-request":
        if (
          this.active?.requestId === message.requestId &&
          (this.active.port === context.port ||
            (context.allowTabCancellation &&
              this.active.tabId === context.tabId &&
              this.active.origin === context.origin))
        ) {
          this.active.controller.abort();
        }
        return;
      case "retry-request":
        await this.retry(context, message.requestId);
        return;
      case "follow-up":
        await this.followUp(context, message.requestId, message.intent);
        return;
    }
  }

  private async start(context: PortContext, input: ReaderStartRequest): Promise<void> {
    const settings = await this.dependencies.settingsRepository.get();
    const request: ReadingRequest = {
      requestId: input.requestId,
      action: input.action,
      selection: input.selection,
      preferences: settings.preferences,
      ...(input.nearbyContext === undefined
        ? {}
        : { nearbyContext: input.nearbyContext }),
    };
    await this.begin(context, request);
  }

  private async retry(context: PortContext, requestId: string): Promise<void> {
    const { session, source } = await this.loadStoredRequest(context, requestId);
    const settings = await this.dependencies.settingsRepository.get();
    const retryRequest = withOptionalSource(
      {
        requestId,
        action: session.action,
        selection: source.selection,
        preferences: settings.preferences,
      },
      source,
      settings.preferences.includeNearbyContext,
    );
    await this.begin(context, retryRequest);
  }

  private async followUp(
    context: PortContext,
    requestId: string,
    intent: FollowUpIntent,
  ): Promise<void> {
    const { session, source } = await this.loadStoredRequest(context, requestId);
    if (!session.answer) {
      throw new PublicError(
        "INVALID_REQUEST",
        "The reading request has no answer to follow up.",
        false,
      );
    }
    const settings = await this.dependencies.settingsRepository.get();
    const followUpRequest = withOptionalSource(
      {
        requestId,
        action: session.action,
        followUpIntent: intent,
        selection: source.selection,
        previousAnswer: session.answer,
        preferences: settings.preferences,
      },
      source,
      settings.preferences.includeNearbyContext,
    );
    await this.begin(context, followUpRequest);
  }

  private async loadStoredRequest(
    context: PortContext,
    requestId: string,
  ): Promise<{ session: ReaderSession; source: PrivateSourceEnvelope }> {
    const owner = this.tabOwnership.get(context.tabId);
    if (owner && owner.epoch > context.epoch) {
      throw new PublicError(
        "INVALID_REQUEST",
        "The stored reading request is unavailable.",
        false,
      );
    }
    const [session, source] = await Promise.all([
      this.dependencies.sessionRepository.getReaderSession(context.tabId),
      this.dependencies.sessionRepository.getPrivateSource(context.tabId),
    ]);
    if (
      !session ||
      !source ||
      session.requestId !== requestId ||
      source.requestId !== requestId ||
      session.origin !== context.origin ||
      source.origin !== context.origin
    ) {
      throw new PublicError(
        "INVALID_REQUEST",
        "The stored reading request is unavailable.",
        false,
      );
    }
    return { session, source };
  }

  private async begin(context: PortContext, input: ReadingRequest): Promise<void> {
    const request = validateReadingRequest(input);
    enforceReadingBudget({
      selection: request.selection,
      ...(request.nearbyContext === undefined
        ? {}
        : { nearbyContext: request.nearbyContext }),
      ...(request.previousAnswer === undefined
        ? {}
        : { previousAnswer: request.previousAnswer }),
    });

    const currentOwner = this.tabOwnership.get(context.tabId);
    if (currentOwner && currentOwner.epoch > context.epoch) {
      throw new PublicError(
        "INVALID_REQUEST",
        "The reader connection is stale.",
        false,
      );
    }

    const replacedActive = this.active;
    if (replacedActive) {
      this.active = undefined;
      replacedActive.controller.abort();
      await this.removeStoredIdentity(replacedActive);
      const replacedOwner = this.tabOwnership.get(replacedActive.tabId);
      if (replacedOwner?.requestId === replacedActive.requestId) {
        this.tabOwnership.delete(replacedActive.tabId);
      }
    }

    const replacedOwner = this.tabOwnership.get(context.tabId);
    if (
      replacedOwner &&
      (replacedOwner.epoch !== context.epoch ||
        replacedOwner.requestId !== request.requestId)
    ) {
      await this.removeStoredIdentity(replacedOwner);
      if (this.tabOwnership.get(context.tabId) === replacedOwner) {
        this.tabOwnership.delete(context.tabId);
      }
    }

    if (context.disconnected) return;
    const generation: ActiveGeneration = {
      requestId: request.requestId,
      tabId: context.tabId,
      origin: context.origin,
      port: context.port,
      controller: new AbortController(),
    };
    this.active = generation;
    this.tabOwnership.set(context.tabId, {
      requestId: request.requestId,
      tabId: context.tabId,
      origin: context.origin,
      port: context.port,
      epoch: context.epoch,
    });

    const session: ReaderSession = {
      tabId: context.tabId,
      requestId: request.requestId,
      selectionPreview: capDisplayCharacters(
        request.selection,
        MAX_SELECTION_PREVIEW_CHARACTERS,
      ),
      action: request.action,
      contextIncluded: request.nearbyContext !== undefined,
      status: "pending",
      answer: "",
      lastSequence: -1,
      origin: context.origin,
    };
    const source: PrivateSourceEnvelope = {
      requestId: request.requestId,
      selection: request.selection,
      origin: context.origin,
      ...(request.nearbyContext === undefined
        ? {}
        : { nearbyContext: request.nearbyContext }),
      ...(request.previousAnswer === undefined
        ? {}
        : { previousAnswer: request.previousAnswer }),
    };

    try {
      await this.mutate(async () => {
        if (this.active !== generation || context.disconnected) return;
        await this.dependencies.sessionRepository.putReaderSession(session);
        await this.dependencies.sessionRepository.putPrivateSource(
          context.tabId,
          source,
        );
      });
      if (this.active !== generation || context.disconnected) {
        generation.controller.abort();
        if (this.active === generation) this.active = undefined;
        return;
      }
      this.post(context.port, { type: "session-snapshot", session });
      const chatRequest = buildChatRequest(request);
      void this.runGeneration(generation, session, chatRequest);
    } catch (error) {
      generation.controller.abort();
      if (this.active === generation) this.active = undefined;
      throw error;
    }
  }

  private async runGeneration(
    generation: ActiveGeneration,
    initialSession: ReaderSession,
    chatRequest: ReturnType<typeof buildChatRequest>,
  ): Promise<void> {
    let session = initialSession;
    const sequence = createStreamSequence(generation.requestId);
    let terminal = false;

    const applyEvent = async (event: StreamEvent): Promise<void> => {
      if (this.active !== generation || event.requestId !== generation.requestId)
        return;
      if (!acceptStreamEvent(sequence, event).accepted) return;
      await this.mutate(async () => {
        if (this.active !== generation) return;
        session = reduceReaderSession(session, event);
        await this.dependencies.sessionRepository.putReaderSession(session);
        if (this.active !== generation) return;
        this.post(generation.port, { type: "stream-event", event });
        this.post(generation.port, { type: "session-snapshot", session });
      });
      terminal =
        event.type === "completed" ||
        event.type === "cancelled" ||
        event.type === "failed";
    };

    try {
      await this.modelGate.runExclusive(generation.controller.signal, async () => {
        for await (const event of this.dependencies.provider.streamChat(
          generation.requestId,
          chatRequest,
          generation.controller.signal,
        )) {
          await applyEvent(event);
        }
      });
    } catch (error) {
      if (!terminal && this.active === generation) {
        const event: StreamEvent = generation.controller.signal.aborted
          ? { type: "cancelled", requestId: generation.requestId }
          : {
              type: "failed",
              requestId: generation.requestId,
              error: publicError(error),
            };
        await applyEvent(event);
      }
    } finally {
      if (this.active === generation) this.active = undefined;
    }
  }

  private enqueueCommand(command: () => Promise<void>): void {
    this.commandQueue = this.commandQueue.then(command, command).catch(() => undefined);
  }

  private mutate(mutation: () => Promise<void>): Promise<void> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async removeTabState(tabId: number): Promise<void> {
    await this.mutate(async () => {
      await this.dependencies.sessionRepository.removeTabState(tabId);
    });
  }

  private async removeStoredIdentity(
    identity: Pick<TrustedReaderIdentity, "tabId" | "origin"> & {
      requestId: string;
    },
  ): Promise<void> {
    await this.mutate(async () => {
      const [session, source] = await Promise.all([
        this.dependencies.sessionRepository.getReaderSession(identity.tabId),
        this.dependencies.sessionRepository.getPrivateSource(identity.tabId),
      ]);
      const records = [session, source].filter(
        (record): record is ReaderSession | PrivateSourceEnvelope =>
          record !== undefined,
      );
      if (
        records.length === 0 ||
        records.some(
          (record) =>
            record.requestId !== identity.requestId ||
            record.origin !== identity.origin,
        )
      ) {
        return;
      }
      await this.dependencies.sessionRepository.removeTabState(identity.tabId);
    });
  }

  private post(port: PortLike, message: BackgroundPortMessage): void {
    try {
      port.postMessage(message);
    } catch {
      // A disconnected runtime port is already handled by its lifecycle listener.
    }
  }
}
