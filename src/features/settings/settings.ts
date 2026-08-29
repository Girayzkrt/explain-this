import { z } from "zod";
import { RECOMMENDED_MODEL } from "../../shared/constants";

export const ExplanationLevelSchema = z.enum(["everyday", "standard", "technical"]);

export const ReadingPreferencesSchema = z.object({
  preferredLanguage: z.string().min(2).max(64),
  explanationLevel: ExplanationLevelSchema,
  preserveEnglishTerms: z.boolean(),
  includeNearbyContext: z.boolean(),
  selectedProvider: z.literal("ollama"),
  selectedModel: z.string().min(1).max(200),
  automaticToolbar: z.boolean(),
  blockedSites: z.array(z.string().min(1).max(255)).max(200),
});

export type ReadingPreferences = z.infer<typeof ReadingPreferencesSchema>;

export const DEFAULT_PREFERENCES: ReadingPreferences = {
  preferredLanguage: "English",
  explanationLevel: "everyday",
  preserveEnglishTerms: true,
  includeNearbyContext: false,
  selectedProvider: "ollama",
  selectedModel: RECOMMENDED_MODEL,
  automaticToolbar: false,
  blockedSites: [],
};

export const DEFAULT_MODEL_PROFILE = {
  model: RECOMMENDED_MODEL,
  numCtx: 4096,
  think: false,
  keepAlive: "5m",
  maxConcurrentRequests: 1,
} as const;

export const createDefaultPreferences = (): ReadingPreferences => ({
  ...DEFAULT_PREFERENCES,
  blockedSites: [],
});

export const createDefaultModelProfile = () => ({ ...DEFAULT_MODEL_PROFILE });
