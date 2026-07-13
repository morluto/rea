import type { z } from "zod";

import type { JsonValue } from "../domain/jsonValue.js";

/** Caller-visible MCP execution hints. */
export interface ToolAnnotations {
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

/** Adapter family responsible for implementing a public MCP tool. */
export type ToolKind =
  | "official-proxy"
  | "enhanced"
  | "native-provider"
  | "artifact-provider"
  | "session";

/** Single source of truth for a public MCP tool. */
export interface ToolContract<Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  readonly examples: readonly ToolExample[];
}
