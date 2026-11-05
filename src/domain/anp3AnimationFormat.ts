import { err, ok, type Result } from "./result.js";

/** `ANP3`, u32 end offset, char[24] package name, u32 animation count. */
export const ANP3_HEADER_BYTES = 36;
const NAME_BYTES = 24;
/** char[24] name followed by three u32 fields, for animations and objects alike. */
const RECORD_BYTES = 36;
/** Compressed keyframe times are signed 16-bit values in 1/60 s units. */
const COMPRESSED_TIME_UNITS_PER_SECOND = 60;
const COMPRESSED_TIME_OFFSET = 8;

/**
 * Keyframe size by ANP3 frame type: 1 is a rotation with a float time, 2 adds a
 * float translation, 3 is the 16-bit compressed form of 1 and 4 of 2.
 */
const FRAME_BYTES: Readonly<Record<number, number>> = {
  1: 20,
  2: 32,
  3: 10,
  4: 16,
};
const COMPRESSED_FRAME_TYPES = new Set([3, 4]);

/** Whether bytes start with an ANP3 animation package signature. */
export const hasAnp3Header = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x41 &&
  bytes[1] === 0x4e &&
  bytes[2] === 0x50 &&
  bytes[3] === 0x33;

export interface Anp3Bone {
  readonly name: string;
  readonly bone_id: number;
  readonly frame_type: number;
  readonly frame_count: number;
}

export interface Anp3Animation {
  readonly index: number;
  readonly name: string;
  /** First byte of the animation record in the file. */
  readonly byteOffset: number;
  /** Record bytes, including its object headers and keyframes. */
  readonly byteLength: number;
  readonly declaredFrameDataBytes: number;
  readonly flags: number;
  readonly keyframeCount: number;
  /** Largest final keyframe time; null without keyframes or a finite time. */
  readonly durationSeconds: number | null;
  readonly bones: readonly Anp3Bone[];
}

export interface Anp3Package {
  readonly packageName: string;
  readonly declaredEndOffset: number;
  readonly animations: readonly Anp3Animation[];
  /** Bytes after the last animation record, such as IMG sector padding. */
  readonly trailingBytes: number;
}

/**
 * Decode every animation and object header of an ANP3 package. Keyframes are
 * skipped except for each object's final time. Truncation and unknown frame
 * types fail with the byte offset instead of a partial package.
 */
export const parseAnp3Package = (
  bytes: Uint8Array,
): Result<Anp3Package, string> => {
  if (!hasAnp3Header(bytes)) return err("missing ANP3 signature");
  if (bytes.length < ANP3_HEADER_BYTES)
    return err(
      `truncated header: expected ${String(ANP3_HEADER_BYTES)} bytes, found ${String(bytes.length)}`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const animationCount = view.getUint32(32, true);
  if (animationCount * RECORD_BYTES > bytes.length - ANP3_HEADER_BYTES)
    return err(
      `declared ${String(animationCount)} animations cannot fit in ${String(bytes.length)} bytes`,
    );
  const animations: Anp3Animation[] = [];
  let position = ANP3_HEADER_BYTES;
  for (let index = 0; index < animationCount; index += 1) {
    const start = position;
    if (RECORD_BYTES > bytes.length - position)
      return err(
        `animation ${String(index)} header at byte ${String(position)} is truncated`,
      );
    const name = recordName(bytes, position);
    const objectCount = view.getUint32(position + NAME_BYTES, true);
    const declaredFrameDataBytes = view.getUint32(
      position + NAME_BYTES + 4,
      true,
    );
    const flags = view.getUint32(position + NAME_BYTES + 8, true);
    position += RECORD_BYTES;
    if (objectCount * RECORD_BYTES > bytes.length - position)
      return err(
        `animation ${String(index)} (${name}) declares ${String(objectCount)} objects beyond the file`,
      );
    const bones: Anp3Bone[] = [];
    let keyframeCount = 0;
    let duration: number | null = null;
    let finite = true;
    for (let object = 0; object < objectCount; object += 1) {
      if (RECORD_BYTES > bytes.length - position)
        return err(
          `animation ${String(index)} (${name}) object ${String(object)} at byte ${String(position)} is truncated`,
        );
      const bone = recordName(bytes, position);
      const frameType = view.getUint32(position + NAME_BYTES, true);
      const frameCount = view.getUint32(position + NAME_BYTES + 4, true);
      const boneId = view.getUint32(position + NAME_BYTES + 8, true);
      const frameBytes = FRAME_BYTES[frameType];
      if (frameBytes === undefined)
        return err(
          `animation ${String(index)} (${name}) object ${String(object)} at byte ${String(position)} has unknown frame type ${String(frameType)}`,
        );
      position += RECORD_BYTES;
      if (frameCount * frameBytes > bytes.length - position)
        return err(
          `animation ${String(index)} (${name}) object ${String(object)} declares ${String(frameCount)} keyframes beyond the file`,
        );
      if (frameCount > 0) {
        const last = position + (frameCount - 1) * frameBytes;
        const time = COMPRESSED_FRAME_TYPES.has(frameType)
          ? view.getInt16(last + COMPRESSED_TIME_OFFSET, true) /
            COMPRESSED_TIME_UNITS_PER_SECOND
          : view.getFloat32(last + frameBytes - 4, true);
        if (Number.isFinite(time)) duration = Math.max(duration ?? time, time);
        else finite = false;
      }
      position += frameCount * frameBytes;
      keyframeCount += frameCount;
      bones.push({
        name: bone,
        bone_id: boneId,
        frame_type: frameType,
        frame_count: frameCount,
      });
    }
    animations.push({
      index,
      name,
      byteOffset: start,
      byteLength: position - start,
      declaredFrameDataBytes,
      flags,
      keyframeCount,
      durationSeconds: finite ? duration : null,
      bones,
    });
  }
  return ok({
    packageName: recordName(bytes, 8),
    declaredEndOffset: view.getUint32(4, true),
    animations,
    trailingBytes: bytes.length - position,
  });
};

/** Names stop at the first NUL; latin1 preserves every stored byte. */
const recordName = (bytes: Uint8Array, offset: number): string => {
  const raw = bytes.subarray(offset, offset + NAME_BYTES);
  const end = raw.indexOf(0);
  return Buffer.from(raw.subarray(0, end === -1 ? NAME_BYTES : end)).toString(
    "latin1",
  );
};
