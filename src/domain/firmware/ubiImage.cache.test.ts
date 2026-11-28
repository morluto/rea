import { expect, it } from "vitest";

import {
  parseUbiImage,
  UBI_MAX_CACHED_GRID_POSITIONS,
  type UbiSmallerGridCacheStats,
} from "./ubiImage.js";
import {
  ubiImage,
  ubiLayoutPebs,
  type UbiFixturePeb,
} from "./ubiImage.fixture.js";

const gridFixture = (dynamicPebs: number) => {
  const wide = { pebSize: 16 * 1024 * 1024, dataOffset: 128 };
  const fileSize = (dynamicPebs + 2) * wide.pebSize;
  const layout = ubiLayoutPebs(
    [{ id: 0, name: "rootfs", type: "dynamic", reservedPebs: dynamicPebs }],
    wide,
  );
  // EC/VID headers do not store PEB size. A small temporary block builds
  // their exact bytes without allocating a 16 MiB block for each header.
  const header = (peb: UbiFixturePeb): Buffer =>
    Buffer.from(
      ubiImage([peb], { ...wide, pebSize: 64 * 1024 }).subarray(
        0,
        wide.dataOffset,
      ),
    );
  const layoutHeaders = layout.map(header);
  const layoutTables = layout.map((peb) => {
    if (peb.kind !== "leb") throw new Error("Layout fixture must be a LEB");
    return peb.data;
  });
  const dynamicHeaders = Array.from({ length: dynamicPebs }, (_, lnum) =>
    header({
      kind: "leb",
      volId: 0,
      lnum,
      data: Buffer.alloc(0),
      sqnum: BigInt(lnum + 2),
    }),
  );
  return { wide, fileSize, layoutTables, layoutHeaders, dynamicHeaders };
};

it.each([
  { dynamicPebs: 6, layoutFirst: true },
  { dynamicPebs: 6, layoutFirst: false },
  { dynamicPebs: 14, layoutFirst: false },
])(
  "bounds smaller-grid state with $dynamicPebs dynamic PEBs, layoutFirst=$layoutFirst",
  async ({ dynamicPebs, layoutFirst }) => {
    const { wide, fileSize, layoutTables, layoutHeaders, dynamicHeaders } =
      gridFixture(dynamicPebs);
    let stats: UbiSmallerGridCacheStats | undefined;
    let gridProbes = 0;
    const parsed = await parseUbiImage(
      fileSize,
      (offset, length) => {
        if (offset < 0 || length < 0 || offset + length > fileSize)
          throw new RangeError("UBI read leaves the virtual image");
        if (length === wide.dataOffset) gridProbes += 1;
        const out = Buffer.alloc(length, 0xff);
        for (let done = 0; done < length;) {
          const position = offset + done;
          const physical = Math.floor(position / wide.pebSize);
          const within = position % wide.pebSize;
          const take = Math.min(length - done, wide.pebSize - within);
          const layoutIndex = layoutFirst
            ? physical < 2
              ? physical
              : -1
            : physical >= dynamicPebs
              ? physical - dynamicPebs
              : -1;
          const dynamicIndex = layoutFirst ? physical - 2 : physical;
          const prefix =
            layoutIndex >= 0
              ? layoutHeaders[layoutIndex]!
              : dynamicHeaders[dynamicIndex]!;
          if (layoutIndex >= 0) {
            // Written layout padding rules out the smaller PEB geometries,
            // after probes have crossed the preceding erased dynamic data.
            out.fill(0, done, done + take);
            const table = layoutTables[layoutIndex]!;
            const start = Math.max(within, wide.dataOffset);
            const end = Math.min(within + take, wide.dataOffset + table.length);
            if (start < end)
              Buffer.from(table).copy(
                out,
                done + start - within,
                start - wide.dataOffset,
                end - wide.dataOffset,
              );
          }
          if (within < wide.dataOffset)
            prefix.copy(
              out,
              done,
              within,
              Math.min(within + take, wide.dataOffset),
            );
          done += take;
        }
        return out;
      },
      {
        onSmallerGridCacheStats: (value) => {
          stats = value;
        },
      },
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        geometry: { pebSize: wide.pebSize, pebCount: dynamicPebs + 2 },
        volumes: [
          {
            name: "rootfs",
            dataBytes: dynamicPebs * (wide.pebSize - wide.dataOffset),
            extractRefusal: null,
          },
        ],
      },
    });
    expect(stats).toBeDefined();
    expect(stats!.cachedPositionCount).toBeLessThanOrEqual(
      UBI_MAX_CACHED_GRID_POSITIONS,
    );
    if (!layoutFirst) {
      expect(gridProbes).toBeGreaterThan(UBI_MAX_CACHED_GRID_POSITIONS);
      expect(stats!.cachedPositionCount).toBe(UBI_MAX_CACHED_GRID_POSITIONS);
    }
  },
);
