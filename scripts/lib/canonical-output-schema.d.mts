import type { Tool } from "@modelcontextprotocol/client";
export function canonicalOutputSchema(name: string): Record<string, unknown>;
export function withCanonicalOutputSchema<T extends Pick<Tool, "name">>(
  tool: T,
): T & { outputSchema: Record<string, unknown> };
