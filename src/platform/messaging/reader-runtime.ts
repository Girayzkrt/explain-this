import { z } from "zod";
import { isSiteBlocked } from "../permissions/site-blocklist";
import type { SettingsRepository } from "../storage/settings-repository";

const ReaderRuntimeMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get-reader-config") }).strict(),
  z.object({ type: z.literal("open-side-panel") }).strict(),
  z.object({ type: z.literal("open-options-page") }).strict(),
]);

const ReaderRuntimeConfigSchema = z
  .object({
    automaticToolbar: z.boolean(),
    includeNearbyContext: z.boolean(),
    blocked: z.boolean(),
  })
  .strict();

export type ReaderRuntimeMessage = z.infer<typeof ReaderRuntimeMessageSchema>;
export type ReaderRuntimeConfig = z.infer<typeof ReaderRuntimeConfigSchema>;

export interface ReaderRuntimeSender {
  id?: string | undefined;
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
}

export interface ReaderRuntimeDependencies {
  extensionId: string;
  settingsRepository: Pick<SettingsRepository, "get">;
  openSidePanel(tabId: number): Promise<void>;
  openOptionsPage(): Promise<void>;
}

export function parseReaderRuntimeMessage(input: unknown): ReaderRuntimeMessage {
  return ReaderRuntimeMessageSchema.parse(input);
}

export function parseReaderRuntimeConfig(input: unknown): ReaderRuntimeConfig {
  return ReaderRuntimeConfigSchema.parse(input);
}

function trustedPageSender(
  sender: ReaderRuntimeSender,
  extensionId: string,
): { tabId: number; pageUrl: string } {
  const tabId = sender.tab?.id;
  const pageUrl = sender.tab?.url;
  if (sender.id !== extensionId || !Number.isInteger(tabId) || !pageUrl) {
    throw new Error("Untrusted reader sender.");
  }
  const url = new URL(pageUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported reader sender.");
  }
  return { tabId: tabId as number, pageUrl };
}

export function createReaderRuntimeHandler(dependencies: ReaderRuntimeDependencies) {
  return async (
    input: unknown,
    sender: ReaderRuntimeSender,
  ): Promise<ReaderRuntimeConfig | undefined> => {
    const message = parseReaderRuntimeMessage(input);
    const trusted = trustedPageSender(sender, dependencies.extensionId);

    if (message.type === "open-side-panel") {
      await dependencies.openSidePanel(trusted.tabId);
      return undefined;
    }
    if (message.type === "open-options-page") {
      await dependencies.openOptionsPage();
      return undefined;
    }

    const stored = await dependencies.settingsRepository.get();
    return {
      automaticToolbar: stored.preferences.automaticToolbar,
      includeNearbyContext: stored.preferences.includeNearbyContext,
      blocked: isSiteBlocked(trusted.pageUrl, stored.preferences.blockedSites),
    };
  };
}
