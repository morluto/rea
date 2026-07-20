import type { z } from "zod";

import type { JsonValue } from "../domain/jsonValue.js";
import type { ToolEffects } from "./toolEffects.js";

/** Caller-visible MCP execution hints. */
interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** One validated example request for an MCP tool contract. */
export interface ToolExample {
  readonly title: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

/** Canonical adapter families responsible for public MCP tools. */
export const TOOL_KINDS = [
  "official-proxy",
  "enhanced",
  "native-provider",
  "artifact-provider",
  "managed-provider",
  "browser-provider",
  "electron-provider",
  "application",
  "session",
] as const;

/** Adapter family responsible for implementing a public MCP tool. */
type ToolKind = (typeof TOOL_KINDS)[number];

/** Single source of truth for a public MCP tool. */
export interface ToolContract<Name extends string = string> {
  readonly name: Name;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  readonly effects: ToolEffects;
  readonly annotations: ToolAnnotations;
  readonly examples: readonly ToolExample[];
}
