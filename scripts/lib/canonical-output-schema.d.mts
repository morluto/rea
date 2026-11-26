import type { Ajv2020 } from "ajv/dist/2020.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
export function canonicalOutputSchema(name: string): Record<string, unknown>;
export function assertCanonicalOutput(
  ajv: Ajv2020,
  tool: Pick<Tool, "name">,
  response: Pick<CallToolResult, "structuredContent">,
): void;
export function withCanonicalOutputSchema<T extends Pick<Tool, "name">>(
  tool: T,
): T & { outputSchema: Record<string, unknown> };
