import { BinaryReader } from "../../domain/binaryContainer.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { hasNibArchiveSignature } from "../../domain/apple/appleArchiveFormat.js";
import { isInterfaceBuilderConnectionClass } from "../../domain/apple/interfaceBuilderKeyedArchive.js";
import {
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../../domain/parseFailure.js";
import {
  InterfaceBuilderDecodeBudget,
  interfaceBuilderDecodeBudgetExceeded,
} from "./InterfaceBuilderDecodeBudget.js";
import { strictUtf8Decoder } from "../../domain/strictUtf8.js";
import { isRecord } from "../../kernel/isRecord.js";

const DEFAULT_DECODE_BUDGET_BYTES = 128 * 1024 * 1024;

interface NibObjectRecord {
  readonly class_index: number;
  readonly value_start: number;
  readonly value_count: number;
}

interface NibValueRecord {
  readonly key_index: number;
  readonly value: JsonValue;
}

/** Parsed NIBArchive payload with the original object indices preserved. */
export interface NibArchiveDocument {
  readonly format_version: number;
  readonly coder_version: number;
  readonly object_count: number;
  readonly connection_object_count: number;
  readonly objects: readonly {
    readonly id: number;
    readonly class_name: string;
    /** Single-valued fields. Repeated serialized keys are disjoint below. */
    readonly values: Readonly<Record<string, JsonValue>>;
    readonly repeated_values?: Readonly<Record<string, readonly JsonValue[]>>;
  }[];
  readonly classes: readonly string[];
  readonly limitations: readonly string[];
}

/** Serialized collection members in source order; metadata fields are not members. */
export const nibCollectionMembers = (
  object: NibArchiveDocument["objects"][number] | undefined,
): readonly JsonValue[] | undefined => {
  if (
    object === undefined ||
    !/^(?:NS|NSMutable)(?:Array|Set)$/u.test(
      object.class_name.replace(/\0+$/u, ""),
    )
  )
    return undefined;
  const keys = ["UINibEncoderEmptyKey", "NS.objects"];
  const populated = keys.filter(
    (key) =>
      Object.hasOwn(object.values, key) ||
      Object.hasOwn(object.repeated_values ?? {}, key),
  );
  if (populated.length > 1) return undefined;
  const key = populated[0];
  if (key === undefined) return [];
  return object.repeated_values?.[key] ?? [object.values[key]!];
};

/** Decode Apple's length-prefixed NIBArchive representation without loading UI classes. */
export const decodeNibArchive = (
  bytes: Buffer,
  budget = new InterfaceBuilderDecodeBudget(DEFAULT_DECODE_BUDGET_BYTES),
): NibArchiveDocument => {
  if (!hasNibArchiveSignature(bytes))
    throw malformedInput("nib-archive", "NIBArchive magic is invalid");
  if (bytes.length < 50)
    throw truncatedInput("nib-archive", "NIBArchive header is truncated");

  const header = new BinaryReader(bytes, true, "nib-archive");
  const formatVersion = header.u32(10);
  const coderVersion = header.u32(14);
  if (formatVersion !== 1)
    throw unsupportedInput(
      "nib-archive",
      `Unsupported NIBArchive format version ${formatVersion}`,
      { undecodedContent: true },
    );

  const objectCount = readCount(header, 18, "object");
  const objectsOffset = readOffset(header, 22, "object");
  const keyCount = readCount(header, 26, "key");
  const keysOffset = readOffset(header, 30, "key");
  const valueCount = readCount(header, 34, "value");
  const valuesOffset = readOffset(header, 38, "value");
  const classCount = readCount(header, 42, "class");
  const classesOffset = readOffset(header, 46, "class");

  assertOrderedOffsets(bytes.length, [
    objectsOffset,
    keysOffset,
    valuesOffset,
    classesOffset,
  ]);
  // Length-prefixed rows still have a minimum size on the wire. Prove each
  // count can fit its own table before charging any projected representation.
  assertTableExtent("object", objectCount, 3, keysOffset - objectsOffset);
  assertTableExtent("key", keyCount, 1, valuesOffset - keysOffset);
  assertTableExtent("value", valueCount, 2, classesOffset - valuesOffset);
  assertTableExtent("class", classCount, 2, bytes.length - classesOffset);
  const objectRecords = readObjects(
    bytes,
    objectsOffset,
    keysOffset,
    objectCount,
    valueCount,
    classCount,
    budget,
  );
  const keys = parseStrings(
    bytes,
    keysOffset,
    valuesOffset,
    keyCount,
    "key",
    budget,
  );
  const classes = parseClasses(
    bytes,
    classesOffset,
    bytes.length,
    classCount,
    budget,
  );
  const neededValues = valueIndexes(objectRecords, valueCount);
  const values = parseValues(
    bytes,
    valuesOffset,
    classesOffset,
    valueCount,
    keyCount,
    neededValues,
    budget,
  );
  for (const { value } of values.values()) {
    if (
      isRecord(value) &&
      typeof value.$nib_object_ref === "number" &&
      value.$nib_object_ref >= objectCount
    )
      throw malformedInput(
        "nib-archive",
        "NIBArchive object reference is outside the object table",
      );
  }
  const objects = objectRecords.flatMap((object, id) => {
    const className = classes[object.class_index];
    if (className === undefined) return [];
    const fields: Record<string, JsonValue> = {};
    const repeated: Record<string, JsonValue[]> = {};
    for (
      let index = object.value_start;
      index < object.value_start + object.value_count;
      index += 1
    ) {
      const value = values.get(index);
      if (value === undefined) continue;
      const key = keys[value.key_index];
      if (key === undefined) continue;
      if (Object.hasOwn(repeated, key)) {
        budget.reserve(
          16,
          "NIBArchive repeated fields exceed the decode budget",
        );
        repeated[key]!.push(value.value);
      } else if (Object.hasOwn(fields, key)) {
        budget.reserve(
          96,
          "NIBArchive repeated fields exceed the decode budget",
        );
        Object.defineProperty(repeated, key, {
          value: [fields[key]!, value.value],
          enumerable: true,
          configurable: true,
          writable: true,
        });
        delete fields[key];
      } else
        // Archive keys are data, including the legacy __proto__ setter name.
        Object.defineProperty(fields, key, {
          value: value.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return [
      {
        id,
        class_name: className,
        values: fields,
        ...(Object.keys(repeated).length === 0
          ? {}
          : { repeated_values: repeated }),
      },
    ];
  });
  let connectionObjectCount = 0;
  for (const object of objects)
    if (isInterfaceBuilderConnectionClass(object.class_name))
      connectionObjectCount += 1;

  return {
    format_version: formatVersion,
    coder_version: coderVersion,
    object_count: objectCount,
    connection_object_count: connectionObjectCount,
    objects,
    classes,
    limitations: [
      "NIBArchive class extensions and unsupported value encodings are retained as unavailable fields.",
      "NIBArchive object relationships are decoded from serialized references; runtime object creation and execution are not performed.",
    ],
  };
};

const visitObjectRecords = (
  bytes: Buffer,
  start: number,
  end: number,
  count: number,
  valueCount: number,
  classCount: number,
  visit: (classIndex: number, valueStart: number, fieldCount: number) => void,
): void => {
  const cursor = { offset: start };
  for (let index = 0; index < count; index += 1) {
    const classIndex = readVarint(bytes, cursor, end);
    const valueStart = readVarint(bytes, cursor, end);
    const fieldCount = readVarint(bytes, cursor, end);
    if (
      classIndex >= classCount ||
      valueStart > valueCount ||
      fieldCount > valueCount - valueStart
    )
      throw malformedInput(
        "nib-archive",
        `NIBArchive object ${index} references an invalid table range`,
      );
    visit(classIndex, valueStart, fieldCount);
  }
};

const readObjects = (
  bytes: Buffer,
  start: number,
  end: number,
  objectCount: number,
  valueCount: number,
  classCount: number,
  budget: InterfaceBuilderDecodeBudget,
): NibObjectRecord[] => {
  const maxBytes = budget.remainingBytes;
  const objectBytes = objectCount * 96;
  if (objectBytes > maxBytes)
    throw interfaceBuilderDecodeBudgetExceeded(
      "nib-archive",
      "NIBArchive object count exceeds the aggregate Interface Builder decode budget",
      maxBytes,
    );
  let projectedFields = 0;
  // The first pass allocates no records. Overlapping references can make a
  // small archive exceed the decoded allowance before any objects are needed.
  visitObjectRecords(
    bytes,
    start,
    end,
    objectCount,
    valueCount,
    classCount,
    (_classIndex, _valueStart, fieldCount) => {
      projectedFields += fieldCount;
      if (
        !Number.isSafeInteger(projectedFields) ||
        projectedFields * 96 > maxBytes - objectBytes
      )
        throw interfaceBuilderDecodeBudgetExceeded(
          "nib-archive",
          "NIBArchive projected field ranges exceed the aggregate Interface Builder decode budget",
          maxBytes,
        );
    },
  );
  budget.reserve(
    objectBytes + projectedFields * 96,
    "NIBArchive object and projected field counts exceed the aggregate Interface Builder decode budget",
  );
  const output: NibObjectRecord[] = [];
  visitObjectRecords(
    bytes,
    start,
    end,
    objectCount,
    valueCount,
    classCount,
    (classIndex, valueStart, fieldCount) => {
      output.push({
        class_index: classIndex,
        value_start: valueStart,
        value_count: fieldCount,
      });
    },
  );
  return output;
};

const parseStrings = (
  bytes: Buffer,
  start: number,
  end: number,
  count: number,
  label: string,
  budget: InterfaceBuilderDecodeBudget,
): string[] => {
  const cursor = { offset: start };
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = readVarint(bytes, cursor, end);
    const next = checkedEnd(cursor.offset, length, end, `${label} ${index}`);
    budget.reserve(
      32 + length * 2,
      `NIBArchive ${label} strings exceed the aggregate Interface Builder decode budget`,
    );
    const value = decodeUtf8(bytes, cursor.offset, next, `${label} ${index}`);
    cursor.offset = next;
    output.push(value);
  }
  return output;
};

const parseClasses = (
  bytes: Buffer,
  start: number,
  end: number,
  count: number,
  budget: InterfaceBuilderDecodeBudget,
): string[] => {
  const cursor = { offset: start };
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = readVarint(bytes, cursor, end);
    const extraCount = readVarint(bytes, cursor, end);
    if (extraCount > 16)
      throw malformedInput(
        "nib-archive",
        `NIBArchive class ${index} has too many extension values`,
      );
    ensureRange(
      cursor.offset,
      extraCount * 4,
      end,
      `class ${index} extensions`,
    );
    cursor.offset += extraCount * 4;
    const next = checkedEnd(cursor.offset, length, end, `class ${index}`);
    budget.reserve(
      32 + length * 2,
      "NIBArchive class names exceed the aggregate Interface Builder decode budget",
    );
    const name = decodeUtf8(
      bytes,
      cursor.offset,
      next,
      `class ${index}`,
    ).replace(/\0+$/u, "");
    cursor.offset = next;
    output.push(name);
  }
  return output;
};

const parseValues = (
  bytes: Buffer,
  start: number,
  end: number,
  count: number,
  keyCount: number,
  needed: ReadonlySet<number>,
  budget: InterfaceBuilderDecodeBudget,
): Map<number, NibValueRecord> => {
  const cursor = { offset: start };
  const output = new Map<number, NibValueRecord>();
  for (let index = 0; index < count; index += 1) {
    const keyIndex = readVarint(bytes, cursor, end);
    if (keyIndex >= keyCount)
      throw malformedInput(
        "nib-archive",
        `NIBArchive value ${index} references an invalid key`,
      );
    ensureRange(cursor.offset, 1, end, `value ${index} type`);
    const type = bytes[cursor.offset++] ?? -1;
    if (!needed.has(index)) {
      skipValue(bytes, cursor, end, type, index);
      continue;
    }
    budget.reserve(
      64,
      "NIBArchive decoded values exceed the aggregate Interface Builder decode budget",
    );
    const value = readValue(bytes, cursor, end, type, index, budget);
    output.set(index, { key_index: keyIndex, value });
  }
  if (cursor.offset > end)
    throw malformedInput(
      "nib-archive",
      "NIBArchive value table overlaps the next table",
    );
  return output;
};

/**
 * Value type tags in a NIBArchive value table. The two boolean tags carry no
 * payload; AppKit's own nib decoder reads tag 4 as NO and tag 5 as YES.
 */
const NibValueType = {
  int8: 0,
  int16: 1,
  int32: 2,
  int64: 3,
  booleanFalse: 4,
  booleanTrue: 5,
  float32: 6,
  float64: 7,
  data: 8,
  nil: 9,
  objectReference: 10,
} as const;

const readValue = (
  bytes: Buffer,
  cursor: { offset: number },
  end: number,
  type: number,
  index: number,
  budget: InterfaceBuilderDecodeBudget,
): JsonValue => {
  switch (type) {
    case NibValueType.int8:
      ensureRange(cursor.offset, 1, end, `value ${index}`);
      return bytes.readInt8(cursor.offset++);
    case NibValueType.int16:
      ensureRange(cursor.offset, 2, end, `value ${index}`);
      {
        const value = bytes.readInt16LE(cursor.offset);
        cursor.offset += 2;
        return value;
      }
    case NibValueType.int32:
      ensureRange(cursor.offset, 4, end, `value ${index}`);
      {
        const value = bytes.readInt32LE(cursor.offset);
        cursor.offset += 4;
        return value;
      }
    case NibValueType.int64:
      ensureRange(cursor.offset, 8, end, `value ${index}`);
      {
        const value = bytes.readBigInt64LE(cursor.offset);
        cursor.offset += 8;
        return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
          value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : value.toString();
      }
    case NibValueType.booleanFalse:
      return false;
    case NibValueType.booleanTrue:
      return true;
    case NibValueType.float32:
      ensureRange(cursor.offset, 4, end, `value ${index}`);
      {
        const value = bytes.readFloatLE(cursor.offset);
        cursor.offset += 4;
        return value;
      }
    case NibValueType.float64:
      ensureRange(cursor.offset, 8, end, `value ${index}`);
      {
        const value = bytes.readDoubleLE(cursor.offset);
        cursor.offset += 8;
        return value;
      }
    case NibValueType.data: {
      const length = readVarint(bytes, cursor, end);
      const next = checkedEnd(
        cursor.offset,
        length,
        end,
        `value ${index} data`,
      );
      budget.reserve(
        32 + 4 * Math.ceil(length / 3),
        `NIBArchive data value ${index} exceeds the aggregate Interface Builder decode budget`,
      );
      const encoded = bytes.subarray(cursor.offset, next).toString("base64");
      cursor.offset = next;
      return { $nib_data_base64: encoded };
    }
    case NibValueType.nil:
      return null;
    case NibValueType.objectReference:
      ensureRange(cursor.offset, 4, end, `value ${index} reference`);
      {
        const objectIndex = bytes.readUInt32LE(cursor.offset);
        cursor.offset += 4;
        return { $nib_object_ref: objectIndex };
      }
    default:
      throw unsupportedInput(
        "nib-archive",
        `NIBArchive value ${index} has unsupported type ${type}`,
        { undecodedContent: true },
      );
  }
};

const skipValue = (
  bytes: Buffer,
  cursor: { offset: number },
  end: number,
  type: number,
  index: number,
): void => {
  switch (type) {
    case NibValueType.int8:
      ensureRange(cursor.offset, 1, end, `value ${index}`);
      cursor.offset += 1;
      return;
    case NibValueType.int16:
      ensureRange(cursor.offset, 2, end, `value ${index}`);
      cursor.offset += 2;
      return;
    case NibValueType.int32:
    case NibValueType.objectReference:
      ensureRange(cursor.offset, 4, end, `value ${index}`);
      cursor.offset += 4;
      return;
    case NibValueType.int64:
    case NibValueType.float64:
      ensureRange(cursor.offset, 8, end, `value ${index}`);
      cursor.offset += 8;
      return;
    case NibValueType.float32:
      ensureRange(cursor.offset, 4, end, `value ${index}`);
      cursor.offset += 4;
      return;
    case NibValueType.booleanFalse:
    case NibValueType.booleanTrue:
    case NibValueType.nil:
      return;
    case NibValueType.data: {
      const length = readVarint(bytes, cursor, end);
      cursor.offset = checkedEnd(
        cursor.offset,
        length,
        end,
        `value ${index} data`,
      );
      return;
    }
    default:
      throw unsupportedInput(
        "nib-archive",
        `NIBArchive value ${index} has unsupported type ${type}`,
        { undecodedContent: true },
      );
  }
};

const valueIndexes = (
  objects: readonly NibObjectRecord[],
  total: number,
): ReadonlySet<number> => {
  const indexes = new Set<number>();
  for (const object of objects)
    for (
      let index = object.value_start;
      index < object.value_start + object.value_count;
      index += 1
    )
      indexes.add(index);
  if (indexes.size > total)
    throw malformedInput(
      "nib-archive",
      "NIBArchive object value ranges exceed the value table",
    );
  return indexes;
};

const assertTableExtent = (
  label: string,
  count: number,
  minimumRowBytes: number,
  availableBytes: number,
): void => {
  if (count > Math.floor(availableBytes / minimumRowBytes))
    throw truncatedInput(
      "nib-archive",
      `NIBArchive ${label} table cannot contain its declared records`,
    );
};

const readCount = (
  header: BinaryReader,
  offset: number,
  label: string,
): number => {
  const count = header.u32(offset);
  if (count > header.bytes.length)
    throw malformedInput(
      "nib-archive",
      `NIBArchive ${label} count exceeds the archive length`,
    );
  return count;
};

const readOffset = (
  header: BinaryReader,
  offset: number,
  label: string,
): number => {
  const value = header.u32(offset);
  if (value < 50 || value > header.bytes.length)
    throw malformedInput(
      "nib-archive",
      `NIBArchive ${label} table offset is invalid`,
    );
  return value;
};

const decodeUtf8 = (
  bytes: Buffer,
  start: number,
  end: number,
  label: string,
): string => {
  try {
    // These are length-prefixed names, not standalone text documents.
    return strictUtf8Decoder("preserve").decode(bytes.subarray(start, end));
  } catch (cause: unknown) {
    throw malformedInput(
      "nib-archive",
      `NIBArchive ${label} is not valid UTF-8`,
      { cause },
    );
  }
};

const readVarint = (
  bytes: Buffer,
  cursor: { offset: number },
  end: number,
): number => {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    ensureRange(cursor.offset, 1, end, "variable integer");
    const byte = bytes[cursor.offset++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) !== 0) {
      if (value > 0x7fff_ffff)
        throw malformedInput(
          "nib-archive",
          "NIBArchive variable integer is out of range",
        );
      return value;
    }
    shift += 7;
  }
  throw malformedInput(
    "nib-archive",
    "NIBArchive variable integer is too long",
  );
};

const checkedEnd = (
  start: number,
  length: number,
  limit: number,
  label: string,
): number => {
  if (!Number.isSafeInteger(length) || length < 0 || start + length > limit)
    throw truncatedInput(
      "nib-archive",
      `NIBArchive ${label} exceeds its table`,
    );
  return start + length;
};

const ensureRange = (
  start: number,
  length: number,
  limit: number,
  label: string,
): void => {
  checkedEnd(start, length, limit, label);
};

const assertOrderedOffsets = (length: number, offsets: readonly number[]) => {
  let previous = 50;
  for (const offset of offsets) {
    if (offset < previous || offset > length)
      throw malformedInput(
        "nib-archive",
        "NIBArchive table offsets are out of order",
      );
    previous = offset;
  }
};
