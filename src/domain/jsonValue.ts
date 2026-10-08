import { z } from "zod";

/** JSON-safe value shared by domain, application, and adapter boundaries. */
export const jsonValueSchema = z.json();
// Every JSON value satisfies `{}`. Advertise that instead of Zod's
// self-referential `$defs` projection, which MCP clients and model APIs that
// reject recursive JSON Schemas refuse. Runtime parsing still admits only JSON.
jsonValueSchema._zod.toJSONSchema = () => ({});

/** JSON object boundary for caller-visible parameter maps. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonValue = z.infer<typeof jsonValueSchema>;
