import {
  buildVersionCommand,
  CPU,
  dylibCommand,
  LC,
  machoImage,
  readerOf,
  segmentCommand,
} from "../artifacts/apple/MachoImage.fixture.js";
import { readMachoCommandNames } from "./MachoCommandNames.js";
import {
  assertSelectedMachoSlice,
  resolveSelectedMachoSlice,
} from "./NativeMachoSelectedSlice.js";
import type { NativeMachoSource } from "./NativeMachoSource.js";
import type { ResolvedMachoSlice } from "./NativeMachoSelectedSlice.js";

interface InspectionFatRow {
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
  readonly cpu: { readonly type: number; readonly subtype: number };
  readonly image: Uint8Array;
}

/** Build independent on-disk FAT declarations for the resolver exercised by inspection. */
export const inspectionFatContext = (
  image = inspectionImage(),
  rows: readonly InspectionFatRow[] = [
    {
      offset: 16384,
      size: 4096,
      alignment: 14,
      cpu: CPU.x86_64,
      image: machoImage({ cpu: CPU.x86_64 }),
    },
    { offset: 32768, size: 8192, alignment: 14, cpu: CPU.arm64, image },
  ],
) => {
  const bytes = Buffer.alloc(
    Math.max(...rows.map(({ offset, size }) => offset + size)),
  );
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(rows.length, 4);
  rows.forEach(({ offset, size, alignment, cpu, image: slice }, index) => {
    if (slice.length > size)
      throw new Error("Mach-O fixture slice exceeds its FAT row");
    const at = 8 + index * 20;
    bytes.writeUInt32BE(cpu.type, at);
    bytes.writeUInt32BE(cpu.subtype >>> 0, at + 4);
    bytes.writeUInt32BE(offset, at + 8);
    bytes.writeUInt32BE(size, at + 12);
    bytes.writeUInt32BE(alignment, at + 16);
    bytes.set(slice, offset);
  });
  return inspectionFatBytesContext(bytes);
};

/** Inspect and resolve from the same FAT bytes supplied by a test. */
export const inspectionFatBytesContext = (bytes: Uint8Array) => {
  const source: NativeMachoSource = {
    bytes: bytes.length,
    readSlice: async (_start, _size, offset, length) =>
      bytes.subarray(offset, offset + length),
  };
  return {
    resolveSlice: (selected: Parameters<typeof resolveSelectedMachoSlice>[1]) =>
      resolveSelectedMachoSlice(source, selected, 10000),
    readCommandNames: async (
      offset: number,
      size: number | null,
      selected: ResolvedMachoSlice | undefined,
    ) => {
      const slice = bytes.subarray(
        offset,
        offset + (size ?? bytes.length - offset),
      );
      const binary = await readMachoCommandNames(
        readerOf(slice),
        slice.length,
        1024 * 1024,
        10000,
      );
      if (size !== null) {
        if (selected === undefined)
          throw new Error("FAT fixture slice was not resolved");
        assertSelectedMachoSlice(source, selected, binary);
      }
      return binary;
    },
  };
};

/** Synthetic on-disk command records consumed by the production binary reader. */
export const inspectionImage = (
  options: {
    readonly uuids?: readonly string[];
    readonly fileType?: number;
    readonly commands?: readonly Uint8Array[];
  } = {},
) => {
  const build = buildVersionCommand(1);
  const buildView = new DataView(build.buffer);
  buildView.setUint32(12, 0x000d0000, true);
  buildView.setUint32(16, 0x000e0200, true);
  const segment = segmentCommand({
    name: "__TEXT",
    vmaddr: 0x100000000n,
    vmsize: 8192n,
  });
  new DataView(segment.buffer).setBigUint64(48, 8192n, true);
  const uuids = (options.uuids ?? ["01234567-89AB-CDEF-0123-456789ABCDEF"]).map(
    (uuid) => {
      const command = new Uint8Array(24);
      const view = new DataView(command.buffer);
      view.setUint32(0, 0x1b, true);
      view.setUint32(4, command.length, true);
      command.set(Buffer.from(uuid.replaceAll("-", ""), "hex"), 8);
      return command;
    },
  );
  return machoImage({
    ...(options.fileType === undefined ? {} : { fileType: options.fileType }),
    commands: options.commands ?? [
      segment,
      dylibCommand(LC.LOAD_DYLIB, "/usr/lib/libSystem.B.dylib"),
      build,
      ...uuids,
    ],
  });
};

export const inspectionReader =
  (image = inspectionImage()) =>
  () =>
    readMachoCommandNames(readerOf(image), image.length, 1024 * 1024, 10000);

/** Encryption facts for inspections whose assertions do not involve them. */
export const unreadEncryption = () =>
  Promise.resolve({
    status: "unread",
    reason: "not read in this test",
  } as const);
