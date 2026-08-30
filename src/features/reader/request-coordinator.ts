import { buildChatRequest } from "../../core/prompts/prompt-builder";
import { enforceReadingBudget } from "../../core/requests/budget";
import { PublicError } from "../../core/requests/public-error";
import { validateReadingRequest } from "../../core/requests/schemas";
import type { FollowUpIntent, ReadingRequest } from "../../core/requests/types";
import { acceptStreamEvent, createStreamSequence } from "../../core/streaming/sequence";
import {
  parseReaderPortMessage,
  type BackgroundPortMessage,
  type ReaderCommandMessage,
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
}

interface TrustedReaderIdentity {
  tabId: number;
  origin: string;
}

interface PortContext extends TrustedReaderIdentity {
  port: PortLike;
  disconnected: boolean;
}

interface ActiveGeneration extends TrustedReaderIdentity {
  requestId: string;
  port: PortLike;
  controller: AbortController;
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
  private commandQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: RequestCoordinatorDependencies) {}

  handle(port: PortLike, sender: TrustedPortSender): void {
    let identity: TrustedReaderIdentity;
    try {
      identity = trustedIdentity(sender);
    } catch (error) {
      this.post(port, { type: "command-failed", error: publicError(error) });
      return;
    }

    const context: PortContext = { ...identity, port, disconnected: false };
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
      if (this.active?.port === port) {
        const active = this.active;
        this.active = undefined;
        active.controller.abort();
      }
      void this.removeTabState(context.tabId);
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  }

  cancelForTab(tabId: number): void {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    if (this.active?.tabId === tabId) {
      const active = this.active;
      this.active = undefined;
      active.controller.abort();
    }
    void this.removeTabState(tabId);
  }

  private async handleCommand(
    context: PortContext,
    message: ReaderCommandMessage,
  ): Promise<void> {
    if (context.disconnected) return;

    switch (message.type) {
      case "start-request":
        await this.begin(context, message.request);
        return;
      case "cancel-request":
        if (
          this.active?.requestId === message.requestId &&
          this.active.port === context.port
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
      if (
        (session && session.origin !== context.origin) ||
        (source && source.origin !== context.origin)
      ) {
        await this.removeTabState(context.tabId);
      }
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

    this.active?.controller.abort();
    const generation: ActiveGeneration = {
      requestId: request.requestId,
      tabId: context.tabId,
      origin: context.origin,
      port: context.port,
      controller: new AbortController(),
    };
    this.active = generation;

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
      for await (const event of this.dependencies.provider.streamChat(
        generation.requestId,
        chatRequest,
        generation.controller.signal,
      )) {
        await applyEvent(event);
      }
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

  private post(port: PortLike, message: BackgroundPortMessage): void {
    try {
      port.postMessage(message);
    } catch {
      // A disconnected runtime port is already handled by its lifecycle listener.
    }
  }
}
