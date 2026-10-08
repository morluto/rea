import { visit } from "jsonc-parser";
import { LosslessNumber } from "lossless-json";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";
import { CaptureFormatError } from "./CaptureFormatError.js";

type Frame =
  | {
      kind: "object";
      pointer: string;
      members: Map<string, unknown>;
      pendingKey?: string;
    }
  | { kind: "array"; pointer: string; items: unknown[] };

/** Materialize upstream JSON events without duplicate folding, prototype setters or numeric rounding. */
export const parseHarJson = (text: string): unknown => {
  const frames: Frame[] = [];
  let result: unknown;
  const valuePointer = (): string => {
    const parent = frames.at(-1);
    if (parent === undefined) return "";
    if (parent.kind === "array")
      return `${parent.pointer}/${parent.items.length}`;
    return parent.pendingKey === undefined
      ? parent.pointer
      : `${parent.pointer}/${parent.pendingKey.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  };
  const checkDepth = (): void => {
    if (frames.length > WEB_NETWORK_CAPTURE_LIMITS.depth)
      throw new CaptureFormatError(
        "input-limit",
        "HAR exceeds the 64-level complete-evidence nesting budget.",
        valuePointer(),
      );
  };
  const append = (value: unknown): void => {
    const parent = frames.at(-1);
    if (parent === undefined) result = value;
    else if (parent.kind === "array") parent.items.push(value);
    else {
      if (parent.pendingKey === undefined)
        throw new TypeError(
          "JSON visitor omitted an object property identity.",
        );
      parent.members.set(parent.pendingKey, value);
      delete parent.pendingKey;
    }
  };
  visit(
    text,
    {
      onObjectBegin: () => {
        checkDepth();
        frames.push({
          kind: "object",
          pointer: valuePointer(),
          members: new Map(),
        });
      },
      onObjectProperty: (key) => {
        if (key === "__proto__")
          throw new CaptureFormatError(
            "unsupported",
            "HAR object contains a __proto__ member that the current JSON schema boundary cannot preserve.",
          );
        const frame = frames.at(-1);
        if (frame?.kind !== "object")
          throw new TypeError(
            "JSON visitor emitted a property outside an object.",
          );
        if (frame.members.has(key))
          throw new CaptureFormatError(
            "format",
            "HAR JSON contains duplicate object members.",
          );
        frame.pendingKey = key;
      },
      onObjectEnd: () => {
        const frame = frames.pop();
        if (frame?.kind !== "object")
          throw new TypeError("JSON visitor ended an unexpected object.");
        append(Object.fromEntries(frame.members));
      },
      onArrayBegin: () => {
        checkDepth();
        frames.push({ kind: "array", pointer: valuePointer(), items: [] });
      },
      onArrayEnd: () => {
        const frame = frames.pop();
        if (frame?.kind !== "array")
          throw new TypeError("JSON visitor ended an unexpected array.");
        append(frame.items);
      },
      onLiteralValue: (value: unknown, offset, length) => {
        checkDepth();
        if (typeof value === "number")
          append(new LosslessNumber(text.slice(offset, offset + length)));
        else if (
          value === null ||
          typeof value === "boolean" ||
          typeof value === "string"
        )
          append(value);
        else
          throw new TypeError("JSON visitor emitted an unsupported literal.");
      },
      onError: () => {
        throw new CaptureFormatError("format", "HAR is malformed JSON.");
      },
    },
    {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    },
  );
  return result;
};
