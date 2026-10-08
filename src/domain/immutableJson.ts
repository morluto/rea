import type { JsonValue } from "./jsonValue.js";

const immutableSnapshots = new WeakSet<object>();
interface SnapshotEntry {
  readonly value: unknown;
  readonly exiting: boolean;
}

/** Recognize an owned JSON snapshot sealed by this module, or an immutable scalar. */
export const isImmutableJsonSnapshot = (value: unknown): value is JsonValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "object" && immutableSnapshots.has(value));

/** Seal an already parsed, owned JSON snapshot for immutable zero-copy reuse. */
export const freezeJsonSnapshot = <T extends JsonValue>(value: T): T => {
  const pending: SnapshotEntry[] = [{ value, exiting: false }];
  // These sets exist only during traversal, while the owned root already
  // retains every child. Strong sets avoid per-node ephemeron GC work.
  const visited = new Set<object>();
  const ancestors = new Set<object>();
  const objects: object[] = [];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    const item = entry.value;
    if (entry.exiting && typeof item === "object" && item !== null) {
      ancestors.delete(item);
      visited.add(item);
      objects.push(item);
      continue;
    }
    if (isImmutableJsonSnapshot(item)) continue;
    if (typeof item !== "object" || item === null)
      throw new TypeError("Immutable JSON snapshots require JSON values");
    if (ancestors.has(item))
      throw new TypeError(
        "Immutable JSON snapshots cannot contain circular references",
      );
    if (visited.has(item)) continue;
    ancestors.add(item);
    pending.push({ value: item, exiting: true });
    pushSnapshotChildren(item, pending);
  }
  // Register only after every value is checked and every object is frozen.
  // An arbitrary Object.freeze call cannot forge this snapshot identity.
  for (const item of objects) Object.freeze(item);
  // Register the requested root, rather than retaining weak entries for every
  // nested object. Sealing an Evidence or bundle skips previously sealed roots.
  if (typeof value === "object" && value !== null)
    immutableSnapshots.add(value);
  return value;
};

/**
 * Seal exclusively owned JSON in bounded steps, authenticating only completion.
 * Abandonment or failure can leave the provisional input partly frozen.
 */
export function* freezeOwnedJsonSnapshotSteps<T extends JsonValue>(
  value: T,
): Generator<void, T> {
  const pending: SnapshotEntry[] = [{ value, exiting: false }];
  const visited = new Set<object>();
  const ancestors = new Set<object>();
  let examined = 0;
  try {
    while (pending.length > 0) {
      if (examined++ === 4096) {
        examined = 0;
        yield;
      }
      const entry = pending.pop();
      if (entry === undefined) break;
      const item = entry.value;
      if (entry.exiting && typeof item === "object" && item !== null) {
        ancestors.delete(item);
        visited.add(item);
        continue;
      }
      if (isImmutableJsonSnapshot(item)) continue;
      if (typeof item !== "object" || item === null)
        throw new TypeError("Immutable JSON snapshots require JSON values");
      if (ancestors.has(item))
        throw new TypeError(
          "Immutable JSON snapshots cannot contain circular references",
        );
      if (visited.has(item)) continue;
      ancestors.add(item);
      pending.push({ value: item, exiting: true });
      pushSnapshotChildren(item, pending);
      // Lock every inspected edge before the scheduler can release control.
      Object.freeze(item);
    }
    if (typeof value === "object" && value !== null)
      immutableSnapshots.add(value);
    return value;
  } finally {
    pending.length = 0;
    visited.clear();
    ancestors.clear();
  }
}

const pushSnapshotChildren = (item: object, pending: SnapshotEntry[]): void => {
  const prototype: unknown = Object.getPrototypeOf(item);
  if (
    !Array.isArray(item) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw new TypeError("Immutable JSON snapshots require ordinary objects");
  if (Array.isArray(item))
    for (let index = 0; index < item.length; index += 1)
      if (!Object.hasOwn(item, index))
        throw new TypeError(
          "Immutable JSON snapshots cannot contain sparse arrays",
        );
  for (const key of Object.getOwnPropertyNames(item)) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      throw new TypeError("Immutable JSON snapshots cannot contain accessors");
    const child: unknown = descriptor.value;
    pending.push({ value: child, exiting: false });
  }
};
