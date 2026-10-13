import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  allocateByDuration,
  parseTestDurations,
  readTestDurations,
} from "../../ciTestSequencer.js";

describe("CI test history", () => {
  it("uses only successful in-root file durations", () => {
    const root = resolve("/workspace/rea");
    const durations = parseTestDurations(
      JSON.stringify({
        version: 1,
        success: true,
        files: [
          {
            name: join(root, "tests/slow.test.ts"),
            durationMs: 100,
          },
          {
            name: join(root, "tests/slow.test.ts"),
            durationMs: 60,
          },
          {
            name: resolve(root, "../outside.test.ts"),
            durationMs: 990,
          },
          { name: "tests/negative.test.ts", durationMs: -1 },
          { name: "tests/zero.test.ts", durationMs: 0 },
          { name: "tests/invalid.test.ts", durationMs: "100" },
          null,
        ],
      }),
      root,
    );

    expect(durations).toEqual(new Map([["tests/slow.test.ts", 100]]));
    expect(
      parseTestDurations('{"version": 1, "success": false, "files": []}', root),
    ).toBeUndefined();
    // Legacy test-body spans must not be mixed with complete module costs.
    expect(
      parseTestDurations(
        JSON.stringify({
          success: true,
          numFailedTests: 0,
          testResults: [
            { name: "tests/legacy.test.ts", startTime: 0, endTime: 100 },
          ],
        }),
        root,
      ),
    ).toBeUndefined();
    expect(parseTestDurations("not json", root)).toBeUndefined();
    expect(parseTestDurations("null", root)).toBeUndefined();
  });

  it("falls back for missing history while preserving real filesystem errors", async () => {
    const temporaryRoot = await createTestTempDirectory("rea-ci-sequencer-");
    const missing = await readTestDurations(
      join(temporaryRoot, "missing.json"),
      temporaryRoot,
    );
    expect(missing).toBeUndefined();

    const directory = join(temporaryRoot, "directory");
    await mkdir(directory);
    const reportPath = join(temporaryRoot, "report.json");
    await writeFile(reportPath, "{");
    expect(await readTestDurations(reportPath, temporaryRoot)).toBeUndefined();

    await expect(
      readTestDurations(directory, temporaryRoot),
    ).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});

describe("duration shard allocation", () => {
  it.prop([
    fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), {
      minLength: 1,
      maxLength: 80,
    }),
    fc.integer({ min: 3, max: 8 }),
  ])(
    "is complete, disjoint, reference-preserving, and input-order independent",
    (ids, shardCount) => {
      const items = ids.map((id, index) => ({
        id,
        path: `tests/${id}.test.ts`,
        project: `project-${id % 3}`,
        pool: id % 2 === 0 ? "forks" : "threads",
        duration: index > 0 && id % 5 === 0 ? undefined : (id % 17) + 1,
      }));
      const specifications = items.map((item) => ({
        item,
        key: `${item.path}\0${item.project}\0${item.pool}`,
        duration: item.duration,
      }));
      const shards = allocateByDuration(specifications, shardCount);
      const reversedShards = allocateByDuration(
        [...specifications].reverse(),
        shardCount,
      );

      expect(shards).toBeDefined();
      expect(reversedShards).toEqual(shards);
      const assigned = shards!.flat();
      expect(assigned).toHaveLength(items.length);
      expect(new Set(assigned).size).toBe(items.length);
      expect(assigned.every((item) => items.includes(item))).toBe(true);
    },
  );

  it("keeps tied path, project, pool, and new-file entries deterministic", () => {
    const items = [
      {
        id: "a",
        path: "tests/shared.test.ts",
        project: "alpha",
        pool: "forks",
        duration: 10,
      },
      {
        id: "b",
        path: "tests/shared.test.ts",
        project: "beta",
        pool: "forks",
        duration: 10,
      },
      {
        id: "c",
        path: "tests/shared.test.ts",
        project: "beta",
        pool: "threads",
        duration: 10,
      },
      {
        id: "new",
        path: "tests/new.test.ts",
        project: "alpha",
        pool: "forks",
        duration: undefined,
      },
    ];
    const specifications = items.map((item) => ({
      item,
      key: `${item.path}\0${item.project}\0${item.pool}`,
      duration: item.duration,
    }));
    const shards = allocateByDuration(specifications, 3);
    const reversedShards = allocateByDuration([...specifications].reverse(), 3);

    expect(shards).toBeDefined();
    expect(reversedShards).toEqual(shards);
    expect(shards!.flat()).toHaveLength(items.length);
    expect(new Set(shards!.flat()).size).toBe(items.length);
  });
});
