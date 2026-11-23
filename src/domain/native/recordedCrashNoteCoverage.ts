type Range = { readonly offset: string; readonly bytes: string };
type Segment = {
  readonly index: number;
  readonly type_id: number;
  readonly offset: string;
  readonly file_size: string;
};
type Note = {
  readonly segment_index: number;
  readonly location: Range;
  readonly owner_location: Range;
  readonly descriptor_location: Range;
};
type Padding = {
  readonly segment_index: number;
  readonly location: Range;
  readonly bytes_base64: string;
};
interface NumericSpan {
  readonly start: bigint;
  readonly end: bigint;
}

const ZERO_PADDING_BASE64_PATTERN = /^A*={0,2}$/;
const align = (size: bigint) => ((size + 3n) / 4n) * 4n;

const layoutMatches = (
  noteStart: bigint,
  noteBytes: bigint,
  note: Note,
): boolean => {
  const owner = BigInt(note.owner_location.bytes);
  const descriptor = BigInt(note.descriptor_location.bytes);
  return (
    BigInt(note.owner_location.offset) === noteStart + 12n &&
    BigInt(note.descriptor_location.offset) ===
      noteStart + 12n + align(owner) &&
    noteBytes === 12n + align(owner) + align(descriptor)
  );
};

const paddingMatches = (
  itemStart: bigint,
  itemBytes: bigint,
  item: Padding,
  segment: Segment | undefined,
): boolean => {
  const decodedLength = Buffer.byteLength(item.bytes_base64, "base64");
  return (
    itemBytes > 0n &&
    itemBytes < 12n &&
    BigInt(decodedLength) === itemBytes &&
    ZERO_PADDING_BASE64_PATTERN.test(item.bytes_base64) &&
    segment !== undefined &&
    itemStart + itemBytes === BigInt(segment.offset) + BigInt(segment.file_size)
  );
};

const compareSpans = (left: NumericSpan, right: NumericSpan): number =>
  left.start < right.start ? -1 : left.start > right.start ? 1 : 0;

/** Require exact aligned note layouts and one complete, nonoverlapping physical coverage. */
export function recordedNoteCoverageIssues(
  segments: readonly Segment[],
  notes: readonly Note[],
  padding: readonly Padding[],
): readonly string[] {
  const issues: string[] = [];
  const bySegment = new Map<number, NumericSpan[]>();
  const all: NumericSpan[] = [];
  const add = (segment: number, start: bigint, bytes: bigint) => {
    const span: NumericSpan = { start, end: start + bytes };
    let ranges = bySegment.get(segment);
    if (ranges === undefined) {
      ranges = [];
      bySegment.set(segment, ranges);
    }
    ranges.push(span);
    all.push(span);
  };
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i]!;
    const start = BigInt(note.location.offset);
    const bytes = BigInt(note.location.bytes);
    if (!layoutMatches(start, bytes, note))
      issues.push(
        "Recorded note layout differs from its aligned header/owner/descriptor ranges.",
      );
    add(note.segment_index, start, bytes);
  }
  for (let i = 0; i < padding.length; i += 1) {
    const item = padding[i]!;
    const start = BigInt(item.location.offset);
    const bytes = BigInt(item.location.bytes);
    if (!paddingMatches(start, bytes, item, segments[item.segment_index]))
      issues.push(
        "Recorded note padding must be a short zero-filled segment tail.",
      );
    add(item.segment_index, start, bytes);
  }
  all.sort(compareSpans);
  let end = 0n;
  for (let i = 0; i < all.length; i += 1) {
    const span = all[i]!;
    if (span.start < end)
      issues.push("Physical recorded note/padding ranges overlap or repeat.");
    if (span.end > end) end = span.end;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment.type_id !== 4) continue;
    let cursor = BigInt(segment.offset);
    const ranges = bySegment.get(segment.index);
    if (ranges !== undefined) {
      ranges.sort(compareSpans);
      for (let j = 0; j < ranges.length; j += 1) {
        const span = ranges[j]!;
        if (span.start !== cursor)
          issues.push(
            "Recorded note/padding ranges leave a gap or overlap in their segment.",
          );
        cursor = span.end;
      }
    }
    if (cursor !== BigInt(segment.offset) + BigInt(segment.file_size))
      issues.push(
        "Recorded note/padding ranges do not completely cover their segment.",
      );
  }
  return issues;
}
