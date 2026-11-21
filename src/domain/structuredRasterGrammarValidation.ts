import type { StructuredRasterGrammar } from "./structuredRasterDiscovery.js";
/** Expected caller-control failure, distinct from implementation RangeErrors. */
export class StructuredRasterControlError extends RangeError {
  constructor(
    readonly fieldPath: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "StructuredRasterControlError";
  }
}
const grammarInteger = (
  n: number,
  name: string,
  min: number,
  max: number,
): void => {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new StructuredRasterControlError(
      name.split("."),
      `${name} must be an integer in ${min}..${max}`,
    );
};
/** Shared by the direct domain API and canonical request schemas. */
export function validateStructuredRasterGrammar(
  grammar: StructuredRasterGrammar,
): void {
  grammarInteger(grammar.recordStride, "recordStride", 4, 128);
  grammarInteger(grammar.scanAlignment, "scanAlignment", 1, 128);
  if (grammar.recordStride % grammar.scanAlignment !== 0)
    throw new StructuredRasterControlError(
      ["scanAlignment"],
      "recordStride must be divisible by scanAlignment",
    );
  if (grammar.endianness !== "little" && grammar.endianness !== "big")
    throw new StructuredRasterControlError(
      ["endianness"],
      "Unsupported endianness",
    );
  if (grammar.payloadBase !== "table-end")
    throw new StructuredRasterControlError(
      ["payloadBase"],
      "Only the explicit table-end base hypothesis is supported",
    );
  grammarInteger(grammar.maxDimension, "maxDimension", 1, 4096);
  grammarInteger(grammar.maxFormat, "maxFormat", 0, 65535);
  if (
    typeof grammar.requireZeroReserved !== "boolean" ||
    typeof grammar.requireMonotonicOffsets !== "boolean"
  )
    throw new StructuredRasterControlError(
      [
        typeof grammar.requireZeroReserved !== "boolean"
          ? "requireZeroReserved"
          : "requireMonotonicOffsets",
      ],
      "Grammar predicates must be boolean",
    );
  const occupied = new Set<number>();
  for (const name of [
    "format",
    "width",
    "height",
    "payloadOffset",
    "reserved",
  ] as const) {
    const field = grammar.fields[name];
    if (field === undefined) {
      if (name === "reserved") continue;
      throw new StructuredRasterControlError(
        ["fields", name],
        `Missing ${name} field`,
      );
    }
    grammarInteger(
      field.offset,
      `fields.${name}.offset`,
      0,
      grammar.recordStride - 1,
    );
    if (
      ![1, 2, 4].includes(field.byteWidth) ||
      field.offset + field.byteWidth > grammar.recordStride
    )
      throw new StructuredRasterControlError(
        ["fields", name],
        "Field lies outside descriptor record",
      );
    for (let i = field.offset; i < field.offset + field.byteWidth; i++) {
      if (occupied.has(i))
        throw new StructuredRasterControlError(
          ["fields", name],
          "Descriptor fields must not overlap",
        );
      occupied.add(i);
    }
  }
  if (grammar.requireZeroReserved && grammar.fields.reserved === undefined)
    throw new StructuredRasterControlError(
      ["fields", "reserved"],
      "Zero-reserved predicate requires a reserved field",
    );
}
export function validateStructuredRasterRecordLimits(
  minRecords: number,
  maxRecords: number,
): void {
  if (maxRecords < minRecords)
    throw new StructuredRasterControlError(
      ["max_records"],
      "max_records must be at least min_records",
    );
}
