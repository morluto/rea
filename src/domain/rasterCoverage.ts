import { err, ok, type Result } from "./result.js";

export interface RasterCoverageRange {
  readonly offset: number;
  readonly length: number;
}
export type RasterCoverageFailure = {
  readonly field: "offset" | "length" | "range";
  readonly index: number;
};
const integer = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

/** Owns normalized observed spans; zero-filled gaps never become coverage.
 * Callers admit source size/range count and translate failures at their boundary.
 */
export class RasterCoverageIndex {
  private constructor(
    readonly bytesLength: number,
    private readonly ranges: readonly RasterCoverageRange[],
  ) {}

  static prepare(
    bytesLength: number,
    ranges: readonly RasterCoverageRange[],
  ): Result<RasterCoverageIndex, RasterCoverageFailure> {
    const sorted: { offset: number; length: number }[] = [];
    for (let index = 0; index < ranges.length; index++) {
      const range = ranges[index]!;
      if (!integer(range.offset, 0, bytesLength))
        return err({ field: "offset", index });
      if (!integer(range.length, 1, bytesLength))
        return err({ field: "length", index });
      if (range.length > bytesLength - range.offset)
        return err({ field: "range", index });
      sorted.push({ offset: range.offset, length: range.length });
    }
    sorted.sort((a, b) => a.offset - b.offset);
    const merged: { offset: number; length: number }[] = [];
    for (const range of sorted) {
      const last = merged.at(-1);
      if (last && range.offset <= last.offset + last.length)
        last.length =
          Math.max(last.offset + last.length, range.offset + range.length) -
          last.offset;
      else merged.push(range);
    }
    return ok(new RasterCoverageIndex(bytesLength, merged));
  }

  covers(offset: number, length: number): boolean {
    if (
      !integer(offset, 0, this.bytesLength) ||
      !integer(length, 1, this.bytesLength) ||
      length > this.bytesLength - offset
    )
      return false;
    let low = 0,
      high = this.ranges.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ranges[mid]!.offset <= offset) low = mid + 1;
      else high = mid;
    }
    const range = this.ranges[low - 1];
    return (
      range !== undefined && offset + length <= range.offset + range.length
    );
  }
}
