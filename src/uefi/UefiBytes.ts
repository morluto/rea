import { Buffer } from "node:buffer";

/**
 * One bounded read-only window: walker offsets stay local, every published
 * offset is image-absolute through `origin`.
 */
export interface ScanRegion {
  readonly buffer: Buffer;
  /** Local start inside `buffer` where the region begins (inclusive). */
  readonly start: number;
  /** Local end inside `buffer` (exclusive). */
  readonly end: number;
  /** Image-absolute address of `start`; published offsets add the local delta. */
  readonly origin: number;
}

/** Build a region over one full-image address range; bounds are clamped. */
export function imageRegion(
  buffer: Buffer,
  start: number,
  end: number,
): ScanRegion {
  const clampedStart = Math.max(0, Math.min(start, buffer.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, buffer.length));
  return { buffer, start: clampedStart, end: clampedEnd, origin: clampedStart };
}

/** Map a local position inside the region to its image-absolute address. */
export function absoluteOffset(
  region: ScanRegion,
  localOffset: number,
): number {
  return region.origin + (localOffset - region.start);
}

/** Map an image-absolute address back to its local position inside the region. */
export function localOffsetOf(
  region: ScanRegion,
  absoluteAddress: number,
): number {
  return absoluteAddress - region.origin + region.start;
}

/** Read bytes of one sub-range as a copy; null when outside region bounds. */
export function sliceRegion(
  region: ScanRegion,
  absoluteStart: number,
  length: number,
): Buffer | null {
  const local = absoluteStart - region.origin + region.start;
  if (
    absoluteStart < region.origin ||
    local < region.start ||
    local + length > region.end
  ) {
    return null;
  }
  return region.buffer.subarray(local, local + length);
}

/** Round up to the next multiple of `alignment`; zero stays zero. */
export function alignUp(value: number, alignment: number): number {
  if (alignment <= 1) {
    return Math.max(0, value);
  }
  return Math.ceil(value / alignment) * alignment;
}

/** Uniformity over a bounded window; out-of-window bytes read as absent. */
export function isWindowUniform(
  buffer: Buffer,
  start: number,
  end: number,
  byte: number,
): boolean {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(end, buffer.length);
  if (boundedStart >= boundedEnd) {
    return false;
  }
  for (let index = boundedStart; index < boundedEnd; index += 1) {
    if (buffer[index] !== byte) {
      return false;
    }
  }
  return true;
}

/** Fractional uniformity sample for classifying large regions cheaply. */
export function sampleUniformity(
  buffer: Buffer,
  start: number,
  end: number,
): number {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(end, buffer.length);
  if (boundedStart >= boundedEnd) {
    return 0;
  }
  const span = boundedEnd - boundedStart;
  const step = Math.max(1, Math.floor(span / 256));
  let matches = 0;
  let samples = 0;
  for (let index = boundedStart; index < boundedEnd; index += step) {
    matches += buffer[index] === 0xff ? 1 : 0;
    samples += 1;
  }
  return matches / samples;
}
