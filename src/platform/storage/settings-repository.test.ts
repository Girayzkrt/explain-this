import { describe, expect, it } from "vitest";
import {
  createDefaultPreferences,
  type ReadingPreferences,
} from "../../features/settings/settings";
import { MemoryStorageArea } from "../../../tests/support/memory-storage";
import { createSettingsRepository } from "./settings-repository";

describe("settings repository", () => {
  it("uses the detected Chrome UI language with safe defaults on first use", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSettingsRepository(storage, () => "nl-NL");

    const expected = {
      onboardingVersion: 0 as const,
      preferences: {
        ...createDefaultPreferences(),
        preferredLanguage: "nl-NL",
      },
    };

    await expect(repository.get()).resolves.toEqual(expected);
    await expect(storage.snapshot()).resolves.toEqual({ settings: expected });
  });

  it("persists only the settings schema and onboarding version", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSettingsRepository(storage, () => "en-US");

    await repository.update({
      selectedModel: "llama3",
      selection: "private selection",
      answer: "private answer",
      prompt: "private prompt",
      url: "https://private.example",
      title: "private title",
    } as unknown as Partial<ReadingPreferences>);
    await repository.markOnboardingComplete();

    await expect(storage.snapshot()).resolves.toEqual({
      settings: {
        onboardingVersion: 1,
        preferences: {
          ...createDefaultPreferences(),
          preferredLanguage: "en-US",
          selectedModel: "llama3",
        },
      },
    });
  });

  it("repairs an invalid stored settings object with safe defaults", async () => {
    const storage = new MemoryStorageArea();
    await storage.set({
      settings: {
        onboardingVersion: 1,
        preferences: { ...createDefaultPreferences(), selectedProvider: "remote" },
      },
    });
    const repository = createSettingsRepository(storage, () => "de-DE");

    const repaired = {
      onboardingVersion: 0,
      preferences: {
        ...createDefaultPreferences(),
        preferredLanguage: "de-DE",
      },
    };

    await expect(repository.get()).resolves.toEqual(repaired);
    await expect(storage.snapshot()).resolves.toEqual({ settings: repaired });
  });

  it("retains onboarding version zero and explicit preferences during ordinary reads", async () => {
    const storage = new MemoryStorageArea();
    const preferences = {
      ...createDefaultPreferences(),
      preferredLanguage: "fr-FR",
      explanationLevel: "technical" as const,
    };
    await storage.set({ settings: { onboardingVersion: 0, preferences } });
    const repository = createSettingsRepository(storage, () => "en-US");

    await expect(repository.get()).resolves.toEqual({
      onboardingVersion: 0,
      preferences,
    });
    await expect(storage.snapshot()).resolves.toEqual({
      settings: { onboardingVersion: 0, preferences },
    });
  });

  it("retains an incomplete version across preference updates until completion", async () => {
    const storage = new MemoryStorageArea();
    const repository = createSettingsRepository(storage, () => "en-US");

    const updated = await repository.update({ explanationLevel: "technical" });

    expect(updated.onboardingVersion).toBe(0);
    await expect(storage.snapshot()).resolves.toMatchObject({
      settings: { onboardingVersion: 0 },
    });

    const completed = await repository.markOnboardingComplete();
    expect(completed.onboardingVersion).toBe(1);
    await expect(storage.snapshot()).resolves.toMatchObject({
      settings: { onboardingVersion: 1 },
    });
  });
});

describe("selectedProvider migration", () => {
  // get() repairs unparseable settings by resetting to defaults, so without a migration an
  // existing install would silently lose its language, level and blocked sites.
  it("rewrites a stored ollama provider and keeps every other preference", async () => {
    const storage = new MemoryStorageArea();
    await storage.set({
      settings: {
        onboardingVersion: 1,
        preferences: {
          preferredLanguage: "Turkish",
          explanationLevel: "technical",
          preserveEnglishTerms: false,
          includeNearbyContext: true,
          selectedProvider: "ollama",
          selectedModel: "gemma3:4b",
          automaticToolbar: true,
          blockedSites: ["example.com"],
        },
      },
    });
    const repository = createSettingsRepository(storage, () => "English");

    const stored = await repository.get();

    expect(stored.preferences.selectedProvider).toBe("ollama-local");
    expect(stored.preferences.preferredLanguage).toBe("Turkish");
    expect(stored.preferences.blockedSites).toEqual(["example.com"]);
    expect(stored.onboardingVersion).toBe(1);
  });

  it("falls back to defaults for a provider value it does not recognise", async () => {
    const storage = new MemoryStorageArea();
    await storage.set({
      settings: {
        onboardingVersion: 1,
        preferences: {
          preferredLanguage: "Turkish",
          explanationLevel: "technical",
          preserveEnglishTerms: false,
          includeNearbyContext: true,
          selectedProvider: "anthropic",
          selectedModel: "gemma3:4b",
          automaticToolbar: true,
          blockedSites: ["example.com"],
        },
      },
    });
    const repository = createSettingsRepository(storage, () => "English");

    const stored = await repository.get();

    expect(stored.preferences.selectedProvider).toBe("ollama-local");
  });
});
