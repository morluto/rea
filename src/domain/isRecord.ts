import type { JsonValue } from "./jsonValue.js";

/**
 * Whether a value is a non-null object other than an array. Its keys,
 * prototype and property values are not inspected.
 */
export function isRecord(
  value: JsonValue | null | undefined,
): value is { [key: string]: JsonValue };
export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
