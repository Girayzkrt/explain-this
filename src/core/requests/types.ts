import type { ReadingPreferences } from "../../features/settings/settings";

export type ReadingAction = "explain" | "simplify" | "translate" | "example";

export type FollowUpIntent =
  | "simpler"
  | "more-detail"
  | "why"
  | "another-example";

export interface ReadingRequest {
  requestId: string;
  action: ReadingAction;
  followUpIntent?: FollowUpIntent;
  selection: string;
  nearbyContext?: string;
  previousAnswer?: string;
  preferences: ReadingPreferences;
}

export interface ValidatedReadingRequest extends ReadingRequest {}

export interface BudgetedReadingContent {
  selection: string;
  nearbyContext?: string | undefined;
  previousAnswer?: string | undefined;
}
