import { PublicError } from "./public-error";
import { estimateTokens } from "./token-estimator";
import type { BudgetedReadingContent } from "./types";

const MAX_SELECTION_TOKENS = 1_600;
const MAX_NEARBY_CONTEXT_TOKENS = 400;
const MAX_PREVIOUS_ANSWER_TOKENS = 600;

export function enforceReadingBudget(
  input: BudgetedReadingContent,
): BudgetedReadingContent {
  if (estimateTokens(input.selection) > MAX_SELECTION_TOKENS) {
    throw new PublicError(
      "SELECTION_TOO_LARGE",
      "SELECTION_TOO_LARGE: The selected text is too large.",
      true,
    );
  }

  if (
    input.nearbyContext !== undefined &&
    estimateTokens(input.nearbyContext) > MAX_NEARBY_CONTEXT_TOKENS
  ) {
    throw new PublicError(
      "CONTEXT_TOO_LARGE",
      "CONTEXT_TOO_LARGE: The nearby context is too large.",
      true,
    );
  }

  if (
    input.previousAnswer !== undefined &&
    estimateTokens(input.previousAnswer) > MAX_PREVIOUS_ANSWER_TOKENS
  ) {
    throw new PublicError(
      "CONTEXT_TOO_LARGE",
      "CONTEXT_TOO_LARGE: The previous answer is too large.",
      true,
    );
  }

  return input;
}
