/** Synthetic IMG version 2 archives and ANP3 animation packages. */
const SECTOR_BYTES = 2048;
const IMG_HEADER_BYTES = 8;
const IMG_ROW_BYTES = 32;
const NAME_BYTES = 24;
const RECORD_BYTES = 36;
const ANP3_HEADER_BYTES = 36;
const FRAME_BYTES = { 1: 20, 2: 32, 3: 10, 4: 16 } as const;
const COMPRESSED_TIME_UNITS_PER_SECOND = 60;
const COMPRESSED_QUATERNION_ONE = 4096;

export interface ImgV2FixtureMember {
  readonly name: string;
  readonly data: Uint8Array;
  /** Which u16 carries the size; some archives leave the archive size 0. */
  readonly sizeField?: "streaming" | "archive";
}

const writeName = (target: Buffer, offset: number, name: string): void => {
  Buffer.from(name, "latin1").copy(target, offset, 0, NAME_BYTES - 1);
};

/** Members follow the directory, each padded to whole sectors. */
export const buildImgV2 = (members: readonly ImgV2FixtureMember[]): Buffer => {
  const directoryEnd = IMG_HEADER_BYTES + members.length * IMG_ROW_BYTES;
  let sector = Math.ceil(directoryEnd / SECTOR_BYTES);
  const header = Buffer.alloc(sector * SECTOR_BYTES);
  header.write("VER2", 0, "latin1");
  header.writeUInt32LE(members.length, 4);
  const bodies: Buffer[] = [];
  members.forEach((member, index) => {
    const sectors = Math.ceil(member.data.length / SECTOR_BYTES);
    const row = IMG_HEADER_BYTES + index * IMG_ROW_BYTES;
    header.writeUInt32LE(sector, row);
    if (member.sizeField === "archive") header.writeUInt16LE(sectors, row + 6);
    else header.writeUInt16LE(sectors, row + 4);
    writeName(header, row + 8, member.name);
    const body = Buffer.alloc(sectors * SECTOR_BYTES);
    Buffer.from(member.data).copy(body);
    bodies.push(body);
    sector += sectors;
  });
  return Buffer.concat([header, ...bodies]);
};

export interface Anp3FixtureObject {
  readonly bone: string;
  readonly boneId: number;
  readonly frameType: 1 | 2 | 3 | 4;
  /** Keyframe times in seconds. */
  readonly times: readonly number[];
}

export interface Anp3FixtureAnimation {
  readonly name: string;
  readonly objects: readonly Anp3FixtureObject[];
}

const keyframes = (object: Anp3FixtureObject): Buffer => {
  const size = FRAME_BYTES[object.frameType];
  const bytes = Buffer.alloc(size * object.times.length);
  object.times.forEach((time, index) => {
    const at = index * size;
    if (object.frameType === 3 || object.frameType === 4) {
      bytes.writeInt16LE(COMPRESSED_QUATERNION_ONE, at + 6);
      bytes.writeInt16LE(
        Math.round(time * COMPRESSED_TIME_UNITS_PER_SECOND),
        at + 8,
      );
    } else {
      bytes.writeFloatLE(1, at + 12);
      bytes.writeFloatLE(time, at + size - 4);
    }
  });
  return bytes;
};

/** One ANP3 package; `padding` appends zero bytes such as IMG sector fill. */
export const buildAnp3 = (
  packageName: string,
  animations: readonly Anp3FixtureAnimation[],
  padding = 0,
): Buffer => {
  const records = animations.map((animation) => {
    const objects = animation.objects.map((object) => {
      const header = Buffer.alloc(RECORD_BYTES);
      writeName(header, 0, object.bone);
      header.writeUInt32LE(object.frameType, NAME_BYTES);
      header.writeUInt32LE(object.times.length, NAME_BYTES + 4);
      header.writeUInt32LE(object.boneId, NAME_BYTES + 8);
      return Buffer.concat([header, keyframes(object)]);
    });
    const header = Buffer.alloc(RECORD_BYTES);
    writeName(header, 0, animation.name);
    header.writeUInt32LE(animation.objects.length, NAME_BYTES);
    header.writeUInt32LE(
      objects.reduce((sum, object) => sum + object.length - RECORD_BYTES, 0),
      NAME_BYTES + 4,
    );
    header.writeUInt32LE(1, NAME_BYTES + 8);
    return Buffer.concat([header, ...objects]);
  });
  const header = Buffer.alloc(ANP3_HEADER_BYTES);
  header.write("ANP3", 0, "latin1");
  const body = Buffer.concat(records);
  header.writeUInt32LE(ANP3_HEADER_BYTES - 8 + body.length, 4);
  writeName(header, 8, packageName);
  header.writeUInt32LE(animations.length, 32);
  return Buffer.concat([header, body, Buffer.alloc(padding)]);
};
