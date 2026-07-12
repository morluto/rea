import { z } from "zod";

/** JSON-safe value shared by domain, application, and adapter boundaries. */
export const jsonValueSchema = z.json();

export type JsonValue = z.infer<typeof jsonValueSchema>;
