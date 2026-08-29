import { z } from "zod";

const ollamaDetailsSchema = z
  .object({
    family: z.string().optional(),
    parameter_size: z.string().optional(),
  })
  .passthrough();

export const ollamaTagModelSchema = z
  .object({
    name: z.string(),
    size: z.number().nonnegative(),
    details: ollamaDetailsSchema.optional(),
  })
  .passthrough();

export const ollamaTagsSchema = z
  .object({
    models: z.array(ollamaTagModelSchema),
  })
  .passthrough();

export const ollamaModelDetailsSchema = z
  .object({
    details: ollamaDetailsSchema,
  })
  .passthrough();

export const ollamaRunningModelsSchema = z
  .object({
    models: z.array(
      z
        .object({
          name: z.string(),
          size: z.number().nonnegative(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const ollamaChatChunkSchema = z
  .object({
    message: z
      .object({
        content: z.string().default(""),
        thinking: z.string().default(""),
      })
      .passthrough(),
    done: z.boolean().default(false),
    total_duration: z.number().nonnegative().optional(),
    prompt_eval_count: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const ollamaPullChunkSchema = z
  .object({
    status: z.string(),
    completed: z.number().nonnegative().optional(),
    total: z.number().nonnegative().optional(),
  })
  .passthrough();

export type OllamaChatChunk = z.infer<typeof ollamaChatChunkSchema>;
export type OllamaPullChunk = z.infer<typeof ollamaPullChunkSchema>;
