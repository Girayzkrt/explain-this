import type { FollowUpIntent, ReadingAction } from "../requests/types";

export const ACTION_INSTRUCTIONS = {
  explain: "Explain the passage clearly at the requested level.",
  simplify: "Rewrite the meaning in simpler language without losing key facts.",
  translate:
    "Translate faithfully into the preferred language and preserve requested English terms.",
  example: "Give one concrete example that makes the passage easier to understand.",
} satisfies Record<ReadingAction, string>;

export const FOLLOW_UP_INSTRUCTIONS = {
  simpler: "Explain the same passage more simply than the prior answer.",
  "more-detail": "Add useful detail while staying focused on the passage.",
  why: "Explain why the passage's claim or mechanism holds.",
  "another-example": "Give a different concrete example from the prior answer.",
} satisfies Record<FollowUpIntent, string>;
