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
      onboardingVersion: 1 as const,
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
      onboardingVersion: 1,
      preferences: {
        ...createDefaultPreferences(),
        preferredLanguage: "de-DE",
      },
    };

    await expect(repository.get()).resolves.toEqual(repaired);
    await expect(storage.snapshot()).resolves.toEqual({ settings: repaired });
  });

  it("migrates onboarding version zero without changing explicit preferences", async () => {
    const storage = new MemoryStorageArea();
    const preferences = {
      ...createDefaultPreferences(),
      preferredLanguage: "fr-FR",
      explanationLevel: "technical" as const,
    };
    await storage.set({ settings: { onboardingVersion: 0, preferences } });
    const repository = createSettingsRepository(storage, () => "en-US");

    await expect(repository.get()).resolves.toEqual({
      onboardingVersion: 1,
      preferences,
    });
    await expect(storage.snapshot()).resolves.toEqual({
      settings: { onboardingVersion: 1, preferences },
    });
  });
});
