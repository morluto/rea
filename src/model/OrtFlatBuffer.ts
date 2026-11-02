import { isUtf8 } from "node:buffer";
import { ModelReportBudget, rejectModel } from "./ModelFormat.js";

export interface OrtTable {
  readonly offset: number;
  readonly length: number;
  readonly vtable: number;
  readonly fields: number;
}

export interface OrtVector {
  readonly offset: number;
  readonly count: number;
}

/** Bounds checked subset of FlatBuffers, owned by the ORT declaration reader. */
export class OrtFlatBuffer {
  readonly #textCache = new Map<number, string | null>();

  constructor(
    readonly bytes: Buffer,
    readonly budget: ModelReportBudget,
  ) {}

  range(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.bytes.length - length
    )
      rejectModel("ORT FlatBuffers reference is outside the file");
  }

  reference(offset: number): number {
    this.range(offset, 4);
    const distance = this.bytes.readUInt32LE(offset);
    if (distance < 4) rejectModel("ORT FlatBuffers reference is invalid");
    const target = offset + distance;
    this.range(target, 4);
    return target;
  }

  table(offset: number): OrtTable {
    this.range(offset, 4);
    // FlatBuffers deduplicates vtables; the shared vtable can follow a table.
    const vtable = offset - this.bytes.readInt32LE(offset);
    this.range(vtable, 4);
    const vtableLength = this.bytes.readUInt16LE(vtable);
    const length = this.bytes.readUInt16LE(vtable + 2);
    if (vtableLength < 4 || vtableLength % 2 !== 0 || length < 4)
      rejectModel("ORT FlatBuffers table has an invalid extent");
    this.range(vtable, vtableLength);
    this.range(offset, length);
    return { offset, length, vtable, fields: (vtableLength - 4) / 2 };
  }

  field(table: OrtTable, index: number, width: number): number | null {
    if (index >= table.fields) return null;
    const displacement = this.bytes.readUInt16LE(table.vtable + 4 + index * 2);
    if (displacement === 0) return null;
    if (displacement < 4 || displacement > table.length - width)
      rejectModel("ORT FlatBuffers field is outside its table");
    return table.offset + displacement;
  }

  child(table: OrtTable, index: number): OrtTable | null {
    const field = this.field(table, index, 4);
    return field === null ? null : this.table(this.reference(field));
  }

  vector(table: OrtTable, index: number, width: number): OrtVector | null {
    const field = this.field(table, index, 4);
    if (field === null) return null;
    const start = this.reference(field);
    const count = this.bytes.readUInt32LE(start);
    this.range(start + 4, count * width);
    return { offset: start + 4, count };
  }

  textAt(reference: number): string {
    const start = this.reference(reference);
    const length = this.bytes.readUInt32LE(start);
    this.range(start + 4, length + 1);
    if (this.bytes[start + 4 + length] !== 0)
      rejectModel("ORT FlatBuffers string lacks its terminator");
    let value = this.#textCache.get(start);
    if (value === undefined && !this.#textCache.has(start)) {
      const bytes = this.bytes.subarray(start + 4, start + 4 + length);
      if (!isUtf8(bytes)) {
        // Cache only the bounded validation outcome. Invalid text never becomes
        // a retained fact and therefore must not consume the report allowance.
        this.#textCache.set(start, null);
        rejectModel("ORT string is not valid UTF-8");
      }
      // Reserve the expanded retained representation before decoding or
      // caching it. A capacity refusal must not allocate the string first.
      this.budget.charge(6 * length + 32);
      value = bytes.toString("utf8");
      this.#textCache.set(start, value);
      return value;
    }
    if (value === null || value === undefined)
      rejectModel("ORT string is not valid UTF-8");
    this.budget.charge(6 * length + 32);
    return value;
  }

  text(table: OrtTable, index: number): string | null {
    const field = this.field(table, index, 4);
    return field === null ? null : this.textAt(field);
  }

  int(table: OrtTable, index: number, fallback = 0): number {
    const field = this.field(table, index, 4);
    return field === null ? fallback : this.bytes.readInt32LE(field);
  }

  intOrNull(table: OrtTable, index: number): number | null {
    const field = this.field(table, index, 4);
    return field === null ? null : this.bytes.readInt32LE(field);
  }

  byte(table: OrtTable, index: number): number {
    const field = this.field(table, index, 1);
    return field === null ? 0 : this.bytes.readUInt8(field);
  }

  long(table: OrtTable, index: number, fallback = 0n): bigint {
    const field = this.field(table, index, 8);
    return field === null ? fallback : this.bytes.readBigInt64LE(field);
  }

  source(table: OrtTable) {
    return {
      source_offset: table.offset,
      source_length: table.length,
      json_pointer: null,
    };
  }
}
