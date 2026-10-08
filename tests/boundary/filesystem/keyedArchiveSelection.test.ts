import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const archive = build({
  $archiver: "NSKeyedArchiver",
  $version: 100000,
  $objects: ["$null", "value"],
  $top: { root: { CF$UID: 1 }, other: { CF$UID: 1 } },
});

const bundle = async () => {
  const root = await createTestTempDirectory("rea-keyed-selection-");
  await mkdir(join(root, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(root, "Contents", "Resources", "Model.plist"),
    Buffer.from(archive),
  );
  return root;
};

const inspect = (bundlePath: string, parameters: Record<string, unknown>) =>
  inspectBundleKeyedArchive({
    bundlePath,
    targetSha256: "a".repeat(64),
    parameters,
  });

it.each([
  [".", "invalid_format", "relative to the active app bundle"],
  ["Contents/../Model.plist", "invalid_format", "canonical relative"],
  ["Contents//Model.plist", "invalid_format", "canonical relative"],
  ["Contents/Resources", "invalid_value", "selects a directory"],
  ["Contents/Resources/Missing.plist", "invalid_value", "No regular file"],
] as const)(
  "reports caller-selected archive path %j as invalid input",
  async (path, reason, message) => {
    const root = await bundle();
    const rejected = await inspect(root, { path }).catch(
      (cause: unknown) => cause,
    );
    expect(rejected).toBeInstanceOf(AnalysisInputError);
    expect(rejected).toMatchObject({
      issues: [
        {
          path: ["path"],
          reason,
          message: expect.stringContaining(message),
        },
      ],
    });
  },
);

it("reports an absent named root with the archive's available roots", async () => {
  const root = await bundle();
  await expect(
    inspect(root, { path: "Contents/Resources/Model.plist", root: "missing" }),
  ).rejects.toMatchObject({
    issues: [
      {
        path: ["root"],
        reason: "invalid_value",
        message: expect.stringContaining("missing"),
        expected: ["root", "other"],
      },
    ],
  });
});

it.each([
  ["plain plist", Buffer.from(build({ plain: true })), "NSKeyedArchiver"],
  [
    "compiled NIBArchive",
    Buffer.concat([Buffer.from("NIBArchive"), Buffer.alloc(40)]),
    "decode_interface_builder",
  ],
])(
  "keeps the decoder reason for a selected %s",
  async (_label, bytes, detail) => {
    const root = await bundle();
    await writeFile(join(root, "Contents", "Resources", "Other.nib"), bytes);
    const rejected = await inspect(root, {
      path: "Contents/Resources/Other.nib",
    }).catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(ArtifactReaderFailure);
    expect(rejected).toMatchObject({
      reason: "format",
      message: expect.stringContaining(detail),
    });
  },
);
