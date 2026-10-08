import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "plist";
import { expect, it } from "vitest";
import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const cases = ["unsafe-integer", "integral-real"] as const;
const fixture = async (kind: (typeof cases)[number]) => {
  const root = await createTestTempDirectory("rea-integer-scalar-");
  const xml = build({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null", "__VALUE__"],
    $top: { root: { CF$UID: 1 } },
  }).replace(
    "<string>__VALUE__</string>",
    kind === "unsafe-integer"
      ? "<integer>9007199254740993</integer>"
      : "<real>9007199254740992</real>",
  );
  const bytes = Buffer.from(xml);
  const path = join(root, "archive.plist");
  await writeFile(path, bytes);
  return {
    root,
    path,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};
const verify = (
  result: ReturnType<typeof keyedArchiveResultSchema.parse>,
  kind: (typeof cases)[number],
  digest: string,
) => {
  expect(result.archive_sha256).toBe(digest);
  expect(result.roots).toEqual({ root: { CF$UID: 1 } });
  expect(
    result.objects.map(({ id, kind: objectKind, status }) => ({
      id,
      kind: objectKind,
      status,
    })),
  ).toEqual([
    { id: 0, kind: "nil", status: "nil" },
    { id: 1, kind: "scalar", status: "observed" },
  ]);
  expect(result.references).toEqual([
    {
      source: null,
      path: ["root"],
      target: 1,
      status: "resolved",
      raw: { CF$UID: 1 },
    },
  ]);
  expect(result.total_objects).toBe(2);
  expect(result.total_references).toBe(1);
  expect(result.offset).toBe(0);
  expect(result.next_offset).toBeNull();
  expect(result.truncated).toBe(false);
  const value = result.objects.find(({ id }) => id === 1)?.value;
  expect(value).toBeDefined();
  if (kind === "integral-real") expect(value).toBe(9007199254740992);
  else {
    const exact =
      typeof value === "object" &&
      value !== null &&
      JSON.stringify(value) ===
        JSON.stringify({ $plist_type: "integer", decimal: "9007199254740993" });
    const disclosed = result.limitations.some(
      (note) =>
        /integer|number/iu.test(note) &&
        /precision|exact range|rounded/iu.test(note),
    );
    expect(exact || disclosed).toBe(true);
  }
};
it.each(cases)(
  "filesystem preserves primitive scalar graph for %s",
  async (kind) => {
    const item = await fixture(kind);
    verify(
      await inspectBundleKeyedArchive({
        bundlePath: item.root,
        targetSha256: item.digest,
        parameters: { path: "archive.plist", limit: 100 },
      }),
      kind,
      item.digest,
    );
  },
);
cliTest.for(cases)(
  "built CLI preserves primitive scalar graph for %s",
  async (kind, { cli }) => {
    const item = await fixture(kind);
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", item.path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode).toBe(0);
    verify(
      keyedArchiveResultSchema.parse(
        parseEvidence(output.json).normalized_result,
      ),
      kind,
      item.digest,
    );
  },
);
