import { BinaryReader } from "../domain/binaryContainer.js";
import type { ManagedFieldConstant } from "../domain/managed/managedFieldConstant.js";
import { managedFailure } from "../domain/managed/managedReaderFailure.js";

type Scalar = ManagedFieldConstant["value"];
type ScalarReader = (
  reader: BinaryReader,
  scope: string,
  offset: number,
) => Scalar;

const booleanValue: ScalarReader = (reader, scope, offset) => {
  const value = reader.u8(0);
  if (value !== 0 && value !== 1)
    throw managedFailure(
      "invalid-blob",
      scope,
      "Boolean Constant must encode zero or one.",
      offset,
    );
  return value === 1;
};

const nullReference: ScalarReader = (reader, scope, offset) => {
  if (reader.u32(0) !== 0)
    throw managedFailure(
      "invalid-blob",
      scope,
      "Class Constant must encode a four-byte null reference.",
      offset,
    );
  return null;
};

const jsonFloat = (value: number): number | string =>
  Object.is(value, -0) ? "-0" : Number.isFinite(value) ? value : String(value);

interface ConstantEncoding {
  readonly name: NonNullable<ManagedFieldConstant["element_type"]>;
  /** Null is a sequence of UTF-16 code units rather than a fixed-width scalar. */
  readonly bytes: number | null;
  readonly read: ScalarReader;
}

/** Each type owns its name, admitted width and decoder in one place. */
const CONSTANT_TYPES: Readonly<Record<number, ConstantEncoding>> = {
  0x02: { name: "boolean", bytes: 1, read: booleanValue },
  0x03: {
    name: "char",
    bytes: 2,
    read: (b) => String.fromCharCode(b.u16(0)),
  },
  0x04: { name: "i1", bytes: 1, read: (b) => b.i8(0) },
  0x05: { name: "u1", bytes: 1, read: (b) => b.u8(0) },
  0x06: { name: "i2", bytes: 2, read: (b) => b.i16(0) },
  0x07: { name: "u2", bytes: 2, read: (b) => b.u16(0) },
  0x08: { name: "i4", bytes: 4, read: (b) => b.i32(0) },
  0x09: { name: "u4", bytes: 4, read: (b) => b.u32(0) },
  0x0a: { name: "i8", bytes: 8, read: (b) => b.i64(0).toString() },
  0x0b: { name: "u8", bytes: 8, read: (b) => b.word(0, 64).toString() },
  0x0c: { name: "r4", bytes: 4, read: (b) => jsonFloat(b.f32(0)) },
  0x0d: { name: "r8", bytes: 8, read: (b) => jsonFloat(b.f64(0)) },
  0x0e: {
    name: "string",
    bytes: null,
    read: (b) => b.bytes.toString("utf16le"),
  },
  0x12: { name: "class", bytes: 4, read: nullReference },
};

export const managedConstantType = (
  code: number,
): ManagedFieldConstant["element_type"] => CONSTANT_TYPES[code]?.name ?? null;

/** ECMA-335 II.22.9/II.23.1.16; preserve wide integers and float encodings exactly. */
export const decodeManagedConstantValue = (
  code: number,
  bytes: Buffer,
  scope: string,
  offset: number,
): Scalar => {
  const encoding = CONSTANT_TYPES[code];
  if (encoding === undefined)
    throw managedFailure(
      "unsupported-metadata",
      scope,
      `Unsupported Constant element type 0x${code.toString(16)}.`,
      offset,
    );
  if (
    encoding.bytes === null
      ? bytes.length % 2 !== 0
      : bytes.length !== encoding.bytes
  )
    throw managedFailure(
      "invalid-blob",
      scope,
      `Constant ${encoding.name} has an invalid encoded byte length.`,
      offset,
    );
  return encoding.read(
    new BinaryReader(bytes, true, "cli-metadata"),
    scope,
    offset,
  );
};
