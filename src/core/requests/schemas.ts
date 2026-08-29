import { z } from "zod";
import { ReadingPreferencesSchema } from "../../features/settings/settings";
import { PublicError } from "./public-error";
import type { ReadingRequest } from "./types";

const TransportTextSchema = z.string().min(1).max(32_000);

export const ReadingRequestSchema = z
  .object({
    requestId: z.uuid(),
    action: z.enum(["explain", "simplify", "translate", "example"]),
    followUpIntent: z
      .enum(["simpler", "more-detail", "why", "another-example"])
      .optional(),
    selection: TransportTextSchema,
    nearbyContext: TransportTextSchema.optional(),
    previousAnswer: TransportTextSchema.optional(),
    preferences: ReadingPreferencesSchema,
  })
  .strict()
  .refine(
    (value) => Boolean(value.followUpIntent) === Boolean(value.previousAnswer),
    {
      message: "Follow-up intent and previous answer must be supplied together.",
    },
  )
  .refine(
    (value) =>
      value.nearbyContext === undefined || value.preferences.includeNearbyContext,
    { message: "Nearby context must be enabled in reading preferences." },
  );

export function validateReadingRequest(input: unknown): ReadingRequest {
  const result = ReadingRequestSchema.safeParse(input);
  if (!result.success) {
    throw new PublicError(
      "INVALID_REQUEST",
      "The reading request was invalid.",
      false,
    );
  }

  return result.data as ReadingRequest;
}
