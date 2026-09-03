import type { ReadingAction } from "../../core/requests/types";
import { z } from "zod";

export type ReaderInvocationCommand =
  | {
      type: "selection-action";
      action: ReadingAction;
      selectionText: string;
    }
  | {
      type: "capture-current-selection";
      action: "explain";
    };

const ReaderInvocationCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("selection-action"),
      action: z.enum(["explain", "simplify", "translate", "example"]),
      selectionText: z.string().min(1).max(32_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("capture-current-selection"),
      action: z.literal("explain"),
    })
    .strict(),
]);

export function parseReaderInvocationCommand(input: unknown): ReaderInvocationCommand {
  return ReaderInvocationCommandSchema.parse(input);
}
