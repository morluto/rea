import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_READ_CONCURRENCY,
  mapWithConcurrency,
} from "../../scripts/verify/bounded-file-reads.mjs";

describe("mapWithConcurrency", () => {
  it("caps peak in-flight callbacks and preserves input order", async () => {
    const items = Array.from({ length: 16 }, (_, index) => index);
    let inFlight = 0;
    let peakInFlight = 0;

    const results = await mapWithConcurrency(
      items,
      async (item, index) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Reverse relative completion timing so out-of-order completion still
        // writes back to the original slot.
        await new Promise((resolve) =>
          setTimeout(resolve, (items.length - item) % 4),
        );
        inFlight -= 1;
        return `${index}:${item * 2}`;
      },
      3,
    );

    expect(peakInFlight).toBe(3);
    expect(results).toEqual(items.map((item, index) => `${index}:${item * 2}`));
  });

  it("reads temporary files with bounded concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-bounded-file-reads-"));
    try {
      const paths = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const path = join(root, `file-${index}.txt`);
          await writeFile(path, `content-${index}`, "utf8");
          return path;
        }),
      );
      let inFlight = 0;
      let peakInFlight = 0;
      const contents = await mapWithConcurrency(
        paths,
        async (path) => {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          try {
            return await readFile(path, "utf8");
          } finally {
            inFlight -= 1;
          }
        },
        4,
      );

      expect(peakInFlight).toBeLessThanOrEqual(4);
      expect(contents).toEqual(
        Array.from({ length: 20 }, (_, index) => `content-${index}`),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty array without calling mapper when items is empty", async () => {
    let called = 0;
    const results = await mapWithConcurrency([], async () => {
      called += 1;
      return called;
    });
    expect(results).toEqual([]);
    expect(called).toBe(0);
    expect(DEFAULT_FILE_READ_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULT_FILE_READ_CONCURRENCY).toBeLessThanOrEqual(128);
  });

  it("stops dispatching new items after a rejection", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 12 }, (_, index) => index);
    let releaseFirstItem!: () => void;
    const firstItemGate = new Promise<void>((resolve) => {
      releaseFirstItem = resolve;
    });
    let firstItemFinished!: () => void;
    const firstItemDone = new Promise<void>((resolve) => {
      firstItemFinished = resolve;
    });

    await expect(
      mapWithConcurrency(
        items,
        async (item) => {
          started.push(item);
          if (item === 0) {
            await firstItemGate;
            firstItemFinished();
            return item;
          }
          if (item === 1) throw new Error("boom");
          return item;
        },
        2,
      ),
    ).rejects.toThrow("boom");

    releaseFirstItem();
    await firstItemDone;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(started).toEqual([0, 1]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid concurrency %s",
    async (invalid) => {
      await expect(
        mapWithConcurrency([1, 2], async (item) => item, invalid),
      ).rejects.toThrow(RangeError);
    },
  );
});
