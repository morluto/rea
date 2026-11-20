import {
  LC,
  machoImage,
  segmentCommand,
} from "../artifacts/apple/MachoImage.fixture.js";

/** `LC_SEGMENT_64` with a VM range backed by the given file range. */
export const mappedSegment = (options: {
  readonly name: string;
  readonly vmaddr: bigint;
  readonly fileoff: bigint;
  readonly filesize: bigint;
}): Uint8Array => {
  const bytes = segmentCommand({
    name: options.name,
    vmaddr: options.vmaddr,
    vmsize: options.filesize,
  });
  const view = new DataView(bytes.buffer);
  view.setBigUint64(40, options.fileoff, true);
  view.setBigUint64(48, options.filesize, true);
  return bytes;
};

/** `LC_MAIN` with the given entry offset and no stack size. */
export const mainCommand = (entryoff: bigint): Uint8Array => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, LC.MAIN, true);
  view.setUint32(4, bytes.length, true);
  view.setBigUint64(8, entryoff, true);
  return bytes;
};

export const TEXT_SEGMENT = mappedSegment({
  name: "__TEXT",
  vmaddr: 0x100000000n,
  fileoff: 0n,
  filesize: 0x4000n,
});

/** A stripped arm64 executable shape: __PAGEZERO, __TEXT, LC_MAIN at 0x460. */
export const strippedMachoWithMain = (): Uint8Array =>
  machoImage({
    commands: [
      segmentCommand({ name: "__PAGEZERO", vmaddr: 0n, vmsize: 0x100000000n }),
      TEXT_SEGMENT,
      mainCommand(0x460n),
    ],
  });
