import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect, it } from "vitest";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { inventoryArtifact } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
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
    platform: "darwin",
  });

it("selects a native filesystem archive using its inventory Unicode spelling", async () => {
  const root = await createTestTempDirectory("rea-keyed-unicode-");
  const directory = "Cafe\u0301";
  const filename = "Mode\u0301le.plist";
  await mkdir(join(root, directory));
  // This golden archive was produced by Foundation; the regression concerns
  // filesystem spelling rather than a synthetic archive representation.
  const bytes = await readFile(
    new URL(
      "../../fixtures/golden/keyed-archive/foundation.xml",
      import.meta.url,
    ),
  );
  await writeFile(join(root, directory, filename), bytes);
  expect(await readdir(join(root, directory))).toEqual([filename]);
  const inventory = await inventoryArtifact(root);
  const path = inventory.occurrences.find(
    ({ entry_kind }) => entry_kind === "file",
  )?.logical_path;
  expect(path).toBe(`${directory}/${filename}`.normalize("NFC"));
  const result = await inspect(root, { path });
  expect(result.archive_path).toBe(`${directory}/${filename}`);
  expect(result.archive_sha256).toBe(
    inventory.nodes.find(({ artifact_id }) =>
      inventory.occurrences.some(
        (entry) =>
          entry.logical_path === path && entry.artifact_id === artifact_id,
      ),
    )?.sha256,
  );
});

it.skipIf(process.platform === "darwin" || process.platform === "win32")(
  "rejects Unicode-equivalent filenames on filesystems that retain both entries",
  async () => {
    const root = await createTestTempDirectory("rea-keyed-unicode-collision-");
    for (const filename of ["Caf\u00e9.plist", "Cafe\u0301.plist"])
      await writeFile(join(root, filename), archive);
    await expect(
      inspect(root, { path: "Caf\u00e9.plist" }),
    ).rejects.toMatchObject({
      issues: [
        {
          path: ["path"],
          reason: "invalid_value",
          message: expect.stringContaining("Unicode-equivalent"),
        },
      ],
    });
  },
);

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

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "rejects a selected unreadable directory before descending into it",
  async () => {
    const root = await bundle();
    const selected = join(root, "Contents", "Resources");
    await chmod(selected, 0);
    try {
      await expect(readdir(selected)).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        inspect(root, { path: "Contents/Resources" }),
      ).rejects.toMatchObject({
        issues: [
          {
            path: ["path"],
            reason: "invalid_value",
            message: expect.stringContaining("selects a directory"),
          },
        ],
      });
    } finally {
      await chmod(selected, 0o700);
    }
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
  [
    "plain plist",
    Buffer.from(build({ plain: true })),
    "it has no $archiver key",
    "inspect_plist",
  ],
  [
    "plist with another archiver",
    Buffer.from(build({ $archiver: "NSArchiver", $objects: [] })),
    'its $archiver is "NSArchiver"',
    "inspect_plist",
  ],
  [
    "compiled NIBArchive",
    Buffer.concat([Buffer.from("NIBArchive"), Buffer.alloc(40)]),
    "compiled NIBArchive",
    "decode_interface_builder",
  ],
])(
  "reports a selected %s as an unsupported target with the workflow that reads it",
  async (_label, bytes, reason, workflow) => {
    const root = await bundle();
    await writeFile(join(root, "Contents", "Resources", "Other.nib"), bytes);
    const rejected = await inspect(root, {
      path: "Contents/Resources/Other.nib",
    }).catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(AnalysisUnsupportedTargetError);
    expect(projectAnalysisError(asAnalysisError(rejected))).toMatchObject({
      code: "unsupported_target",
      message: expect.stringContaining(reason),
      remediation: { action: expect.stringContaining(workflow) },
      details: {
        operation: "inspect_keyed_archive",
        path: join(root, "Contents", "Resources", "Other.nib"),
      },
    });
  },
);

it.each([
  ["darwin", "Inspect an ordinary property list with inspect_plist"],
  [
    "linux",
    "inspect_plist, which reads ordinary property lists, requires a macOS host",
  ],
] as const)(
  "names the property-list workflow available on a %s host",
  async (platform, action) => {
    const root = await createTestTempDirectory("rea-keyed-kind-");
    const path = join(root, "Defaults.plist");
    await writeFile(path, Buffer.from(build({ plain: true })));
    const result = await new ArtifactProvider(process.env, platform)
      .createClient({
        path,
        sha256: "0".repeat(64),
        kind: "artifact",
        format: "plist",
      })
      .execute("inspect_keyed_archive", {});
    if (result.ok) throw new Error("Expected an unsupported target");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "unsupported_target",
      remediation: { action: expect.stringContaining(action) },
      details: { path },
    });
  },
);

it("keeps a damaged NSKeyedArchiver archive a format failure", async () => {
  const root = await bundle();
  await writeFile(
    join(root, "Contents", "Resources", "Damaged.plist"),
    Buffer.from(build({ $archiver: "NSKeyedArchiver", $top: {} })),
  );
  const rejected = await inspect(root, {
    path: "Contents/Resources/Damaged.plist",
  }).catch((cause: unknown) => cause);
  expect(rejected).toBeInstanceOf(ArtifactReaderFailure);
  expect(rejected).toMatchObject({
    reason: "format",
    message: expect.stringContaining("$objects array"),
  });
});

const asAnalysisError = (value: unknown): AnalysisError => {
  if (!(value instanceof AnalysisError)) throw value;
  return value;
};
