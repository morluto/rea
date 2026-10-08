import { createHash } from "node:crypto";
import type { JsonValue } from "./jsonValue.js";

type DigestFrame =
  | { readonly kind: "separator" }
  | { readonly kind: "value"; readonly value: JsonValue }
  | { readonly kind: "string"; readonly value: string; index: number }
  | {
      readonly kind: "array";
      readonly value: readonly JsonValue[];
      readonly length: number;
      index: number;
    }
  | {
      readonly kind: "object";
      readonly value: { readonly [key: string]: JsonValue };
      readonly keys: readonly string[];
      index: number;
      written: number;
    };

/** Hash owned, validated JSON in bounded steps without a document-sized string. */
export function* canonicalJsonDigestSteps(
  value: JsonValue,
): Generator<void, string> {
  const hash = createHash("sha256");
  const ancestors = new Set<object>();
  const stack: DigestFrame[] = [{ kind: "value", value }];
  let buffered = "";
  let flushed = false;
  const emit = (part: string): void => {
    buffered += part;
    if (buffered.length >= 8192) {
      hash.update(buffered);
      buffered = "";
      flushed = true;
    }
  };
  try {
    while (stack.length > 0) {
      if (flushed) {
        flushed = false;
        yield;
      }
      const frame = stack.pop();
      if (frame === undefined) break;
      if (frame.kind === "separator") {
        emit(":");
        continue;
      }
      if (frame.kind === "string") {
        if (frame.index === frame.value.length) {
          emit('"');
          continue;
        }
        let end = Math.min(frame.index + 8192, frame.value.length);
        const last = frame.value.charCodeAt(end - 1);
        const next = frame.value.charCodeAt(end);
        if (
          end < frame.value.length &&
          last >= 0xd800 &&
          last <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          end -= 1;
        emit(JSON.stringify(frame.value.slice(frame.index, end)).slice(1, -1));
        frame.index = end;
        stack.push(frame);
        continue;
      }
      if (frame.kind === "array") {
        if (frame.index === frame.length) {
          emit("]");
          ancestors.delete(frame.value);
          continue;
        }
        const item = frame.value[frame.index];
        if (item === undefined)
          throw new TypeError(
            "Canonical JSON digest requires dense JSON arrays",
          );
        if (frame.index++ > 0) emit(",");
        stack.push(frame, { kind: "value", value: item });
        continue;
      }
      if (frame.kind === "object") {
        if (frame.index === frame.keys.length) {
          emit("}");
          ancestors.delete(frame.value);
          continue;
        }
        const key = frame.keys[frame.index++];
        if (key === undefined)
          throw new TypeError("Canonical JSON object changed during hashing");
        const item = frame.value[key];
        if (item === undefined) continue;
        if (frame.written++ > 0) emit(",");
        if (key.length > 8192) {
          emit('"');
          stack.push(
            frame,
            { kind: "value", value: item },
            { kind: "separator" },
            { kind: "string", value: key, index: 0 },
          );
          continue;
        }
        emit(JSON.stringify(key));
        emit(":");
        stack.push(frame, { kind: "value", value: item });
        continue;
      }
      const item = frame.value;
      if (typeof item === "string" && item.length > 8192) {
        emit('"');
        stack.push({ kind: "string", value: item, index: 0 });
      } else if (item === null || typeof item !== "object") {
        if (typeof item === "number" && !Number.isFinite(item))
          throw new Error(
            Number.isNaN(item)
              ? "NaN is not allowed"
              : "Infinity is not allowed",
          );
        emit(JSON.stringify(item));
      } else {
        if (ancestors.has(item)) throw new Error("Circular reference detected");
        ancestors.add(item);
        if (Array.isArray(item)) {
          emit("[");
          stack.push({
            kind: "array",
            value: item,
            length: item.length,
            index: 0,
          });
        } else {
          emit("{");
          stack.push({
            kind: "object",
            value: item,
            keys: Object.keys(item).sort(),
            index: 0,
            written: 0,
          });
        }
      }
    }
    if (buffered !== "") hash.update(buffered);
    return hash.digest("hex");
  } finally {
    stack.length = 0;
    ancestors.clear();
    buffered = "";
  }
}
