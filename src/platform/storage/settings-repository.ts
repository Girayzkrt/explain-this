import { z } from "zod";
import {
  createDefaultPreferences,
  ReadingPreferencesSchema,
  type ReadingPreferences,
} from "../../features/settings/settings";
import type { StorageAreaLike } from "./storage-area";

const SETTINGS_KEY = "settings";
const CURRENT_ONBOARDING_VERSION = 1 as const;

const StrictReadingPreferencesSchema = ReadingPreferencesSchema.strict();
const PersistedSettingsSchema = z
  .object({
    onboardingVersion: z.union([z.literal(0), z.literal(CURRENT_ONBOARDING_VERSION)]),
    preferences: StrictReadingPreferencesSchema,
  })
  .strict();

export interface StoredSettings {
  onboardingVersion: typeof CURRENT_ONBOARDING_VERSION;
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
    const parsed = PersistedSettingsSchema.safeParse(stored[SETTINGS_KEY]);

    if (!parsed.success) {
      const repaired = this.defaults();
      await this.persist(repaired);
      return repaired;
    }

    const settings: StoredSettings = {
      onboardingVersion: CURRENT_ONBOARDING_VERSION,
      preferences: parsed.data.preferences,
    };
    if (parsed.data.onboardingVersion === 0) await this.persist(settings);
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
      onboardingVersion: CURRENT_ONBOARDING_VERSION,
      preferences: preferences.data,
    };
    await this.persist(updated);
    return updated;
  }

  async markOnboardingComplete(): Promise<StoredSettings> {
    const settings = await this.get();
    await this.persist(settings);
    return settings;
  }

  private defaults(): StoredSettings {
    return {
      onboardingVersion: CURRENT_ONBOARDING_VERSION,
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
