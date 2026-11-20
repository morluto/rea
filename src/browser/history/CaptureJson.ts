import { escapeJsonPointerToken } from "../../domain/jsonPointer.js";
import { captureBudgets } from "./CaptureBudgets.js";
import { visit } from "jsonc-parser";
import { LosslessNumber } from "lossless-json";
import { CaptureFormatError } from "./CaptureFormatError.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../domain/webNetworkCapture.js";

type Frame =
  | {
      kind: "object";
      pointer: string;
      members: Map<string, unknown>;
      pendingKey?: string;
    }
  | { kind: "array"; pointer: string; items: unknown[] };

/** Admit each retained parser node before its object or numeric wrapper is allocated. */
const captureNodeAdmission = (maximumNodes: number | undefined) => {
  let nodes = 0;
  return (): void => {
    nodes++;
    if (maximumNodes !== undefined && nodes > maximumNodes)
      throw new CaptureFormatError(
        { name: "parser-nodes", maximum: maximumNodes },
        "JSON exceeds its parser node representation allowance.",
      );
  };
};

const selectCaptureObjectProperty = (
  frames: Frame[],
  key: string,
  format: string,
): void => {
  const frame = frames.at(-1);
  if (frame?.kind !== "object")
    throw new TypeError("JSON visitor emitted a property outside an object.");
  if (frame.members.has(key))
    throw new CaptureFormatError(
      "malformed",
      `${format} JSON contains duplicate object members.`,
    );
  frame.pendingKey = key;
};

/** Materialize upstream JSON events without duplicate folding, prototype setters or numeric rounding. */
export const parseCaptureJson = (
  text: string,
  format: "HAR" | "qlog" | "Playwright trace",
  maximumNodes?: number,
): unknown => {
  const frames: Frame[] = [];
  const admitNode = captureNodeAdmission(maximumNodes);
  const fixedDepth = format === "Playwright trace";
  const maximumDepth = fixedDepth
    ? WEB_NETWORK_CAPTURE_LIMITS.depth
    : captureBudgets().depth;
  let result: unknown;
  const valuePointer = (): string => {
    const parent = frames.at(-1);
    if (parent === undefined) return "";
    if (parent.kind === "array")
      return `${parent.pointer}/${parent.items.length}`;
    return parent.pendingKey === undefined
      ? parent.pointer
      : `${parent.pointer}/${escapeJsonPointerToken(parent.pendingKey)}`;
  };
  // The document root is container level 1. Admit a container only while
  // its own level stays within the budget; values inside an admitted
  // container add no level, so empty and scalar-bearing containers agree.
  const admitContainer = (): void => {
    admitNode();
    if (frames.length >= maximumDepth)
      throw new CaptureFormatError(
        { name: "nesting-depth", maximum: maximumDepth },
        `${format} exceeds ${fixedDepth ? "its fixed JSON nesting allowance" : "max_nesting_depth"} (${String(maximumDepth)} levels).`,
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
  const endContainer = (kind: "object" | "array"): void => {
    const frame = frames.pop();
    if (frame?.kind !== kind)
      throw new TypeError(`JSON visitor ended an unexpected ${kind}.`);
    append(
      frame.kind === "object" ? Object.fromEntries(frame.members) : frame.items,
    );
  };
  visit(
    text,
    {
      onObjectBegin: () => {
        admitContainer();
        frames.push({
          kind: "object",
          pointer: valuePointer(),
          members: new Map(),
        });
      },
      onObjectProperty: (key) => {
        admitNode();
        selectCaptureObjectProperty(frames, key, format);
      },
      onObjectEnd: () => endContainer("object"),
      onArrayBegin: () => {
        admitContainer();
        frames.push({ kind: "array", pointer: valuePointer(), items: [] });
      },
      onArrayEnd: () => endContainer("array"),
      onLiteralValue: (value: unknown, offset, length) => {
        admitNode();
        if (typeof value === "number")
          append(new LosslessNumber(text.slice(offset, offset + length)));
        // jsonc-parser 3.3.1 builds an escaped string fragment by fragment,
        // which V8 keeps as a rope several times larger than its text.
        // JSON.parse of the same accepted token returns one flat string.
        else if (typeof value === "string")
          append(JSON.parse(text.slice(offset, offset + length)));
        else if (value === null || typeof value === "boolean") append(value);
        else
          throw new TypeError("JSON visitor emitted an unsupported literal.");
      },
      onError: () => {
        throw new CaptureFormatError(
          "malformed",
          `${format} is malformed JSON.`,
        );
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

/** UTF-8 JSON decoding skips one permitted BOM and rejects malformed bytes. */
export const decodeCaptureText = (
  bytes: Uint8Array,
  format: "HAR" | "qlog",
): string => {
  try {
    // Exported HAR and qlog files may carry a BOM signature (RFC 8259 8.1).
    return decodeStrictUtf8(bytes, "strip-signature");
  } catch {
    throw new CaptureFormatError(
      "malformed",
      `${format} is not valid UTF-8 JSON.`,
    );
  }
};
