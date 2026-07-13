import { z } from "zod";

/** JSON-safe value shared by domain, application, and adapter boundaries. */
export const jsonValueSchema = z.json();

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonValue = z.infer<typeof jsonValueSchema>;
