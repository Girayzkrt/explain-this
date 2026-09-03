import { z } from "zod";
import {
  createDefaultPreferences,
  DEFAULT_PREFERENCES,
  ReadingPreferencesSchema,
  SelectedProviderSchema,
  type ReadingPreferences,
} from "../../features/settings/settings";
import type { StorageAreaLike } from "./storage-area";

const SETTINGS_KEY = "settings";
export const CURRENT_ONBOARDING_VERSION = 1 as const;
export type OnboardingVersion = 0 | typeof CURRENT_ONBOARDING_VERSION;

const StrictReadingPreferencesSchema = ReadingPreferencesSchema.strict();
const PersistedSettingsSchema = z
  .object({
    onboardingVersion: z.union([z.literal(0), z.literal(CURRENT_ONBOARDING_VERSION)]),
    preferences: StrictReadingPreferencesSchema,
  })
  .strict();

/**
 * The provider was a single literal before cloud mode existed, and the enum has grown
 * since. Only `selectedProvider` is rewritten here: an unrecognised value (an older
 * literal, or one from a future build this one doesn't know about yet) falls back to
 * the default for that field alone. Every other preference — language, level, blocked
 * sites, the model, the onboarding version — passes through untouched, so a value this
 * build doesn't recognise costs the reader one field, not a silent reset of everything
 * they configured.
 */
function migrateStoredSettings(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null) return stored;
  const settings = stored as Record<string, unknown>;
  const preferences = settings.preferences;
  if (typeof preferences !== "object" || preferences === null) return stored;
  const values = preferences as Record<string, unknown>;
  if (values.selectedProvider === "ollama") {
    return {
      ...settings,
      preferences: { ...values, selectedProvider: "ollama-local" },
    };
  }
  if (!SelectedProviderSchema.safeParse(values.selectedProvider).success) {
    return {
      ...settings,
      preferences: {
        ...values,
        selectedProvider: DEFAULT_PREFERENCES.selectedProvider,
      },
    };
  }
  return stored;
}

export interface StoredSettings {
  onboardingVersion: OnboardingVersion;
  preferences: ReadingPreferences;
}

export interface SettingsRepository {
  get(): Promise<StoredSettings>;
  update(patch: Partial<ReadingPreferences>): Promise<StoredSettings>;
  markOnboardingComplete(): Promise<StoredSettings>;
}

const preferenceKeys = [
  "preferredLanguage",
  "explanationLevel",
  "preserveEnglishTerms",
  "includeNearbyContext",
  "selectedProvider",
  "selectedModel",
  "automaticToolbar",
  "blockedSites",
] as const satisfies readonly (keyof ReadingPreferences)[];

function defaultPreferences(uiLanguage: string): ReadingPreferences {
  const defaults = createDefaultPreferences();
  const preferredLanguage = uiLanguage.trim();
  const language = z.string().min(2).max(64).safeParse(preferredLanguage);

  return {
    ...defaults,
    preferredLanguage: language.success ? language.data : defaults.preferredLanguage,
  };
}

class LocalSettingsRepository implements SettingsRepository {
  constructor(
    private readonly storage: StorageAreaLike,
    private readonly getUiLanguage: () => string,
  ) {}

  async get(): Promise<StoredSettings> {
    const stored = await this.storage.get(SETTINGS_KEY);
    const parsed = PersistedSettingsSchema.safeParse(
      migrateStoredSettings(stored[SETTINGS_KEY]),
    );

    if (!parsed.success) {
      const repaired = this.defaults();
      await this.persist(repaired);
      return repaired;
    }

    const settings: StoredSettings = {
      onboardingVersion: parsed.data.onboardingVersion,
      preferences: parsed.data.preferences,
    };
    return settings;
  }

  async update(patch: Partial<ReadingPreferences>): Promise<StoredSettings> {
    const current = await this.get();
    const candidate: Record<string, unknown> = { ...current.preferences };

    for (const key of preferenceKeys) {
      if (Object.hasOwn(patch, key)) candidate[key] = patch[key];
    }

    const preferences = StrictReadingPreferencesSchema.safeParse(candidate);
    if (!preferences.success) return current;

    const updated: StoredSettings = {
      onboardingVersion: current.onboardingVersion,
      preferences: preferences.data,
    };
    await this.persist(updated);
    return updated;
  }

  async markOnboardingComplete(): Promise<StoredSettings> {
    const current = await this.get();
    const completed: StoredSettings = {
      ...current,
      onboardingVersion: CURRENT_ONBOARDING_VERSION,
    };
    await this.persist(completed);
    return completed;
  }

  private defaults(): StoredSettings {
    return {
      onboardingVersion: 0,
      preferences: defaultPreferences(this.getUiLanguage()),
    };
  }

  private async persist(settings: StoredSettings): Promise<void> {
    await this.storage.set({ [SETTINGS_KEY]: settings });
  }
}

export function createSettingsRepository(
  storage: StorageAreaLike,
  getUiLanguage: () => string,
): SettingsRepository {
  return new LocalSettingsRepository(storage, getUiLanguage);
}
