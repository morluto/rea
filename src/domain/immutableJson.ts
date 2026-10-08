import type { JsonValue } from "./jsonValue.js";

const immutableSnapshots = new WeakSet<object>();

/** Recognize an owned JSON snapshot sealed by this module, or an immutable scalar. */
export const isImmutableJsonSnapshot = (value: unknown): value is JsonValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "object" && immutableSnapshots.has(value));

/** Seal an already parsed, owned JSON snapshot for immutable zero-copy reuse. */
export const freezeJsonSnapshot = <T extends JsonValue>(value: T): T => {
  const pending: { value: unknown; exiting: boolean }[] = [
    { value, exiting: false },
  ];
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
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      !Array.isArray(item) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw new TypeError("Immutable JSON snapshots require ordinary objects");
    if (ancestors.has(item))
      throw new TypeError(
        "Immutable JSON snapshots cannot contain circular references",
      );
    if (visited.has(item)) continue;
    ancestors.add(item);
    pending.push({ value: item, exiting: true });
    if (Array.isArray(item))
      for (let index = 0; index < item.length; index += 1)
        if (!Object.hasOwn(item, index))
          throw new TypeError(
            "Immutable JSON snapshots cannot contain sparse arrays",
          );
    for (const key of Object.getOwnPropertyNames(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
        throw new TypeError(
          "Immutable JSON snapshots cannot contain accessors",
        );
      const child: unknown = descriptor.value;
      pending.push({ value: child, exiting: false });
    }
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
