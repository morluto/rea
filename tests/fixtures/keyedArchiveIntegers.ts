import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect } from "vitest";
import { z } from "zod";
import { keyedArchiveResultSchema } from "../../src/domain/apple/keyedArchive.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

const rowSchema = z.object({
  container: z.enum(["roots", "objects"]),
  root: z.string(),
  objectId: z.number().int().nonnegative().optional(),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  kind: z.enum(["integer", "real"]),
  literal: z.string(),
});
const archiveSchema = z.object({
  filename: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  rows: z.array(rowSchema),
});
const oracleSchema = z.object({ xml: archiveSchema, binary: archiveSchema });
export const keyedArchiveIntegerFormats = ["xml", "binary"] as const;
export const keyedArchiveIntegerCases = ["controls", "unsafe"] as const;
type Format = (typeof keyedArchiveIntegerFormats)[number];
type Case = (typeof keyedArchiveIntegerCases)[number];
type Row = z.infer<typeof rowSchema>;
export const keyedArchiveIntegerFixture = async (format: Format) => {
  const root = await createTestTempDirectory("rea-keyed-integers-");
  await promisify(execFile)(
    "/usr/bin/xcrun",
    [
      "swift",
      "-module-cache-path",
      join(root, "modules"),
      "tests/conformance/native/keyed-archive-integers.swift",
      root,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const oracle = oracleSchema.parse(
    JSON.parse(await readFile(join(root, "oracle.json"), "utf8")),
  );
  for (const entry of [oracle.xml, oracle.binary]) {
    expect(entry.rows).toContainEqual(
      expect.objectContaining({
        root: "unsafeSigned",
        kind: "integer",
        literal: "9007199254740993",
      }),
    );
    expect(entry.rows).toContainEqual(
      expect.objectContaining({
        root: "unsafeNegative",
        kind: "integer",
        literal: "-9223372036854775808",
      }),
    );
    expect(
      entry.rows.some(
        (row) =>
          row.root === "boxedUnsigned" &&
          row.kind === "integer" &&
          row.literal === "9007199254740993",
      ),
    ).toBe(true);
    expect(
      entry.rows.some(
        (row) =>
          row.root === "boxedReal" &&
          row.kind === "real" &&
          Number(row.literal) === 9007199254740992,
      ),
    ).toBe(true);
  }
  const selected = oracle[format];
  const archivePath = join(root, selected.filename);
  const bytes = await readFile(archivePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(digest).toBe(selected.sha256);
  return { root, selected, archivePath, digest };
};
const at = (value: unknown, path: Row["path"]): unknown => {
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
};
export const expectKeyedArchiveIntegerCase = (
  result: z.infer<typeof keyedArchiveResultSchema>,
  selectedCase: Case,
  selected: z.infer<typeof archiveSchema>,
  digest: string,
) => {
  expect(result.archive_sha256).toBe(digest);
  const unsafe = (row: Row) =>
    row.kind === "integer" &&
    (BigInt(row.literal) > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(row.literal) < BigInt(Number.MIN_SAFE_INTEGER));
  const rows = selected.rows.filter((row) =>
    selectedCase === "unsafe" ? unsafe(row) : !unsafe(row),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const value = at(
      row.container === "roots"
        ? result.roots
        : result.objects.find((object) => object.id === row.objectId)?.value,
      row.path,
    );
    expect(
      value,
      `${row.root} numeric slot remains present`,
    ).not.toBeUndefined();
    if (unsafe(row)) {
      const exact =
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).$plist_type === "integer" &&
        (value as Record<string, unknown>).decimal ===
          BigInt(row.literal).toString();
      // The accepted alternate contract must explicitly disclose numeric precision loss.
      const disclosed = result.limitations.some(
        (reason) =>
          /integer|number/iu.test(reason) &&
          /precision|exact range|rounded/iu.test(reason),
      );
      expect(
        exact || disclosed,
        `${row.root} ${row.literal} must be exact or disclose numeric loss`,
      ).toBe(true);
    } else {
      expect(typeof value, `${row.root} retains its numeric type`).toBe(
        "number",
      );
      expect(value).toBe(Number(row.literal));
    }
  }
};
