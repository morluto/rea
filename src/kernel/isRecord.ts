/** The non-array object members of `T`. */
type RecordMembers<T> = Exclude<Extract<T, object>, readonly unknown[]>;

/**
 * Whether a value is a non-null object other than an array. Its keys,
 * prototype and property values are not inspected. A typed value narrows to
 * its non-array object members (a `JsonValue` to its JSON object) with string
 * keys; `unknown` narrows to `Record<string, unknown>`.
 */
export function isRecord<T>(
  value: T,
): value is ([RecordMembers<T>] extends [never] ? T : RecordMembers<T>) &
  Record<string, unknown>;
export function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
