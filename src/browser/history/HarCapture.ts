import { createHash } from "node:crypto";
import { isSafeNumber, LosslessNumber, parse } from "lossless-json";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCapture,
  type WebNetworkCaptureRecord,
} from "../../domain/webNetworkCapture.js";
import { CaptureFormatError } from "./CaptureFormatError.js";
import {
  CaptureRedaction,
  captureObject,
  capturePointer,
} from "./CaptureRedaction.js";
import { createHarValidator } from "./HarSchema.js";
import { HAR_CAPTURE_PROVIDER_IDENTITY } from "./CaptureRelease.js";

type DecodedCapture = Omit<
  WebNetworkCapture,
  "artifact" | "format" | "runtime_attribution" | "limitations"
>;
type Projection = Pick<
  WebNetworkCaptureRecord,
  "reported" | "numeric_literals" | "binary_fields" | "redactions"
>;

/** Decode a retained HAR with exact numeric lexemes and unchanged upstream schema validation. */
export const decodeHarCapture = (
  text: string,
  sensitiveValues: readonly string[],
): DecodedCapture => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (cause: unknown) {
    if (cause instanceof RangeError)
      throw new CaptureFormatError(
        "input-limit",
        "HAR exceeds the decoder's recursion budget.",
      );
    throw new CaptureFormatError(
      "format",
      "HAR is malformed JSON or contains duplicate object keys.",
    );
  }
  const validation = projectHar(raw, [], false);
  createHarValidator()(validation.reported);
  if (
    !captureObject(raw) ||
    !captureObject(raw.log) ||
    !Array.isArray(raw.log.entries)
  )
    throw new CaptureFormatError("format", "HAR must contain log.entries.");
  if (raw.log.version !== "1.2")
    throw new CaptureFormatError(
      "unsupported",
      "Only the pinned HAR 1.2 schema profile is supported.",
      "/log/version",
    );
  const entries = raw.log.entries;
  const recordsExcluded = ["log", "entries"].some((key) =>
    sensitiveValues.some((literal) => key.includes(literal)),
  );
  const container = projectHar(
    { ...raw, log: { ...raw.log, entries: null } },
    sensitiveValues,
    true,
  );
  const records = entries.map((entry, ordinal): WebNetworkCaptureRecord => {
    // Validate each original record even when a structural ancestor excludes it.
    const projected = projectHar(entry, sensitiveValues, true);
    const projection: Projection = recordsExcluded
      ? {
          reported: null,
          numeric_literals: [],
          binary_fields: [],
          redactions: [{ pointer: "", reason: "explicit-sensitive-value" }],
        }
      : projected;
    return {
      ordinal,
      location: recordsExcluded
        ? { kind: "unknown", reason: "explicit-sensitive-value" }
        : { kind: "json-pointer", pointer: `/log/entries/${ordinal}` },
      ...projection,
      limitations: [
        "HAR text is producer-decoded Unicode. Original body bytes remain unknown unless content explicitly uses valid base64; declared sizes are preserved independently of retained bytes. mitmproxy 12.2.3 SaveHar may report null optional postData.text; that null is retained and omitted only from the upstream validation copy.",
        ...(recordsExcluded
          ? [
              "This record's payload and sidecars are excluded because its structural ancestor property was explicitly marked sensitive.",
            ]
          : []),
      ],
    };
  });
  return {
    decoder: {
      id: HAR_CAPTURE_PROVIDER_IDENTITY.id,
      version: HAR_CAPTURE_PROVIDER_IDENTITY.version,
    },
    container: {
      reported: container.reported,
      numeric_literals: container.numeric_literals,
      redactions: container.redactions,
      records_pointer: recordsExcluded ? null : "/log/entries",
    },
    total_records: records.length,
    records,
  };
};

const projectHar = (
  value: unknown,
  sensitiveValues: readonly string[],
  redact: boolean,
): Projection => {
  const redactor = new CaptureRedaction(sensitiveValues);
  const numeric_literals: Projection["numeric_literals"] = [];
  const binary_fields: Projection["binary_fields"] = [];
  const visit = (
    item: unknown,
    pointer: string,
    depth: number,
    parent?: Readonly<Record<string, unknown>>,
  ): JsonValue => {
    if (depth > WEB_NETWORK_CAPTURE_LIMITS.depth)
      throw new CaptureFormatError(
        "input-limit",
        "HAR exceeds the 64-level complete-evidence nesting budget.",
        pointer,
      );
    if (
      redact &&
      parent !== undefined &&
      redactor.harCredential(pointer, parent)
    )
      return redactor.credential(pointer);
    if (item instanceof LosslessNumber) {
      numeric_literals.push({
        pointer,
        producer_type: "json-number",
        literal: item.value,
      });
      return isSafeNumber(item.value) ? Number(item.value) : null;
    }
    if (typeof item === "string") {
      if (
        redact &&
        pointer === "/response/content/text" &&
        parent?.encoding === "base64"
      ) {
        const bytes = decodeHarBase64(item, pointer);
        const hidden =
          redactor.sensitiveBytes(bytes) ||
          sensitiveValues.some((literal) => item.includes(literal));
        binary_fields.push(
          hidden
            ? {
                pointer,
                representation: "har-base64-content",
                state: "redacted",
                content_base64: null,
                bytes: null,
                sha256: null,
              }
            : {
                pointer,
                representation: "har-base64-content",
                state: "retained",
                content_base64: bytes.toString("base64"),
                bytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              },
        );
        if (hidden) {
          redactor.redactions.push({
            pointer,
            reason: "explicit-sensitive-value",
          });
          return null;
        }
      }
      return redact
        ? redactor.text(
            item,
            pointer,
            redactor.harTransportUrl(pointer, parent),
          )
        : item;
    }
    if (item === null || typeof item === "boolean") return item;
    if (Array.isArray(item))
      return item.map((child, index) =>
        visit(child, capturePointer(pointer, String(index)), depth + 1),
      );
    if (captureObject(item))
      return Object.fromEntries(
        Object.entries(item).flatMap(([key, child]) => {
          if (
            redact &&
            sensitiveValues.some((literal) => key.includes(literal))
          ) {
            const beforeNumbers = numeric_literals.length;
            const beforeBinaries = binary_fields.length;
            const beforeRedactions = redactor.redactions.length;
            visit(child, capturePointer(pointer, key), depth + 1, item);
            numeric_literals.splice(beforeNumbers);
            binary_fields.splice(beforeBinaries);
            redactor.redactions.splice(beforeRedactions);
            redactor.redactions.push({
              pointer,
              reason: "explicit-sensitive-value",
              scope: "property-name",
            });
            return [];
          }
          return [
            [key, visit(child, capturePointer(pointer, key), depth + 1, item)],
          ];
        }),
      );
    throw new CaptureFormatError(
      "format",
      "HAR parser returned a non-JSON value.",
      pointer,
    );
  };
  return {
    reported: visit(value, "", 0),
    numeric_literals,
    binary_fields,
    redactions: redactor.redactions,
  };
};

const decodeHarBase64 = (value: string, pointer: string): Buffer => {
  const compact = value.replace(/[\t\n\r ]/g, "");
  const bytes = Buffer.from(compact, "base64");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      compact,
    ) ||
    bytes.toString("base64") !== compact
  )
    throw new CaptureFormatError(
      "format",
      "HAR content declares base64 but its text is not valid canonical base64 (ASCII whitespace is allowed).",
      pointer,
    );
  return bytes;
};
