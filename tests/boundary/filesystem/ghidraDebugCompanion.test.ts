import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AnalysisArtifactChangedError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

import {
  admitDebugCompanion,
  readMachoFileUuidEntries,
} from "../../../src/application/DebugCompanionAdmission.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { dsymPathSelectionOption } from "../../../src/cli/options.js";
import { openBinaryInputSchema } from "../../../src/contracts/sessionLifecycleInputs.js";
import { GhidraAdmissionError } from "../../../src/ghidra/GhidraAdmissionError.js";
import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import { stageGhidraDebugCompanion } from "../../../src/ghidra/GhidraDebugCompanion.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const stagingFixture = async () => {
  const root = await createTestTempDirectory("rea-dsym-staging-");
  const bytes = Buffer.from("caller-selected DWARF member bytes");
  const runtime = join(root, "private-runtime");
  await mkdir(runtime);
  const memberPath = join(root, "original-member");
  await writeFile(memberPath, bytes, { mode: 0o640 });
  return {
    bytes,
    runtime,
    snapshot: join(runtime, "snapshot-name"),
    stagedBundle: join(runtime, "snapshot-name.dSYM"),
    stagedMember: join(
      runtime,
      "snapshot-name.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "snapshot-name",
    ),
    companion: {
      sourcePath: join(root, "caller.dSYM"),
      memberPath,
      memberSha256: createHash("sha256").update(bytes).digest("hex"),
      memberSizeBytes: bytes.length,
      uuid: "11111111-2222-3333-4444-555555555555",
    },
  };
};

it("stages verified bytes under the snapshot name with private permissions and source provenance", async () => {
  const fixture = await stagingFixture();
  const sourceBefore = await stat(fixture.companion.memberPath);
  expect(
    await stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
    ),
  ).toEqual({
    dsym: {
      source_path: fixture.companion.sourcePath,
      member_sha256: fixture.companion.memberSha256,
      uuid: fixture.companion.uuid,
      staged_member: fixture.stagedMember,
    },
  });
  expect((await readFile(fixture.stagedMember)).equals(fixture.bytes)).toBe(
    true,
  );
  expect(
    (await readFile(fixture.companion.memberPath)).equals(fixture.bytes),
  ).toBe(true);
  if (process.platform !== "win32") {
    expect((await stat(fixture.stagedMember)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.companion.memberPath)).mode).toBe(
      sourceBefore.mode,
    );
  }
});

it("rejects a changed digest and removes the partial staged bundle while preserving source bytes", async () => {
  const fixture = await stagingFixture();
  await expect(
    stageGhidraDebugCompanion(
      { ...fixture.companion, memberSha256: "0".repeat(64) },
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toThrow("dSYM member digest mismatch");
  await expect(access(fixture.stagedBundle)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(
    (await readFile(fixture.companion.memberPath)).equals(fixture.bytes),
  ).toBe(true);
});

it("bounds a grown member by its admitted size and cleans the staged copy", async () => {
  const fixture = await stagingFixture();
  await expect(
    stageGhidraDebugCompanion(
      { ...fixture.companion, memberSizeBytes: fixture.bytes.length - 1 },
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toThrow("grew beyond its admitted size");
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(
    (await readFile(fixture.companion.memberPath)).equals(fixture.bytes),
  ).toBe(true);
});

it("cleans partial staging after cancellation without changing the selected member", async () => {
  const fixture = await stagingFixture();
  const controller = new AbortController();
  controller.abort(new Error("cancel dSYM staging"));
  await expect(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
    reason: "cancelled",
  });
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(
    (await readFile(fixture.companion.memberPath)).equals(fixture.bytes),
  ).toBe(true);
});

it("reads a UUID after a sparse command span above the former allocation ceiling", async () => {
  const root = await createTestTempDirectory("rea-dsym-sparse-commands-");
  const path = join(root, "large-command-image");
  const commandBytes = 200 * 1024 * 1024;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x01000007, 4);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(commandBytes, 20);
  header.writeUInt32LE(0x77777777, 32); // An opaque command body is skipped.
  header.writeUInt32LE(commandBytes - 24, 36);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  Buffer.from("11111111222233334444555555555555", "hex").copy(uuid, 8);
  const handle = await open(path, "wx+");
  try {
    await handle.truncate(32 + commandBytes);
    await handle.write(header, 0, header.length, 0);
    await handle.write(uuid, 0, uuid.length, 32 + commandBytes - uuid.length);
    expect(await readMachoFileUuidEntries(handle, 32 + commandBytes)).toEqual({
      ok: true,
      value: [
        {
          cpuType: 0x01000007,
          cpuSubtypeBase: 0,
          uuid: "11111111-2222-3333-4444-555555555555",
        },
      ],
    });
  } finally {
    await handle.close();
  }
});

it("classifies a disappeared admitted member and removes the staging bundle", async () => {
  const fixture = await stagingFixture();
  await rm(fixture.companion.memberPath);
  await expect(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toBeInstanceOf(AnalysisArtifactChangedError);
  expect(await readdir(fixture.runtime)).toEqual([]);
});

it.each([
  {
    name: "table overlap",
    offset: 8,
    alignment: 0,
    subtype: 0,
    reason: "invalid slice range",
  },
  {
    name: "misalignment",
    offset: 33,
    alignment: 4,
    subtype: 0,
    reason: "not aligned",
  },
  {
    name: "CPU identity disagreement",
    offset: 32,
    alignment: 0,
    subtype: 1,
    reason: "CPU type/subtype disagrees",
  },
])(
  "rejects a FAT member with $name through the format owner",
  async ({ offset, alignment, subtype, reason }) => {
    const root = await createTestTempDirectory("rea-dsym-fat-owner-");
    const path = join(root, "member");
    const bytes = Buffer.alloc(128);
    bytes.writeUInt32BE(0xcafebabe, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(0x01000007, 8);
    bytes.writeUInt32BE(subtype, 12);
    bytes.writeUInt32BE(offset, 16);
    bytes.writeUInt32BE(56, 20);
    bytes.writeUInt32BE(alignment, 24);
    // The overlapping case must be refused before any thin-header interpretation.
    if (offset >= 28) {
      bytes.writeUInt32LE(0xfeedfacf, offset);
      bytes.writeUInt32LE(0x01000007, offset + 4);
      bytes.writeUInt32LE(1, offset + 16);
      bytes.writeUInt32LE(24, offset + 20);
      bytes.writeUInt32LE(0x1b, offset + 32);
      bytes.writeUInt32LE(24, offset + 36);
      Buffer.from("11111111222233334444555555555555", "hex").copy(
        bytes,
        offset + 40,
      );
    }
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      expect(
        await readMachoFileUuidEntries(handle, bytes.length),
      ).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-image",
          reason: expect.stringContaining(reason),
        },
      });
    } finally {
      await handle.close();
    }
  },
);

const uuidImage = (uuid: string, suffix = "") => {
  const bytes = Buffer.alloc(56 + Buffer.byteLength(suffix));
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  Buffer.from(uuid.replaceAll("-", ""), "hex").copy(bytes, 40);
  bytes.write(suffix, 56);
  return bytes;
};

const admissionFixture = async (
  targetUuid = "11111111-2222-3333-4444-555555555555",
) => {
  const root = await createTestTempDirectory("rea-dsym-identity-");
  const dsymPath = join(root, "selected.dSYM");
  const directory = join(dsymPath, "Contents", "Resources", "DWARF");
  await mkdir(directory, { recursive: true });
  const target = join(root, "target");
  await writeFile(target, uuidImage(targetUuid));
  await writeFile(
    join(directory, "member"),
    uuidImage("11111111-2222-3333-4444-555555555555"),
  );
  const admit = async () => {
    const targetHandle = await open(target, "r");
    try {
      return await admitDebugCompanion({
        dsymPath,
        targetHandle,
        targetSize: 56,
        architecture: "x86_64",
      });
    } finally {
      await targetHandle.close();
    }
  };
  return { directory, admit };
};

it("rejects different matching members and admits byte-identical duplicates", async () => {
  const fixture = await admissionFixture();
  const duplicate = join(fixture.directory, "another");
  await writeFile(
    duplicate,
    uuidImage("11111111-2222-3333-4444-555555555555", "different DWARF"),
  );
  expect(await fixture.admit()).toMatchObject({
    ok: false,
    error: {
      diagnostics: {
        architecture: "x86_64",
        target_uuid: "11111111-2222-3333-4444-555555555555",
        rejection: "conflicting_matching_members",
      },
    },
  });
  await writeFile(duplicate, uuidImage("11111111-2222-3333-4444-555555555555"));
  expect(await fixture.admit()).toMatchObject({ ok: true });
});
it("skips an oversized nonmatching member but refuses an oversized matching member", async () => {
  const fixture = await admissionFixture();
  const oversized = join(fixture.directory, "a-first-noise");
  await writeFile(oversized, uuidImage("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
  const noise = await open(oversized, "r+");
  try {
    await noise.truncate(1024 * 1024 * 1024 + 1);
  } finally {
    await noise.close();
  }
  expect(await fixture.admit()).toMatchObject({ ok: true });
  await writeFile(oversized, uuidImage("11111111-2222-3333-4444-555555555555"));
  const matching = await open(oversized, "r+");
  try {
    await matching.truncate(1024 * 1024 * 1024 + 1);
  } finally {
    await matching.close();
  }
  expect(await fixture.admit()).toMatchObject({
    ok: false,
    error: {
      reason: expect.stringContaining("exceeds the supported size"),
      remediationAction: expect.stringContaining("no runtime override"),
      diagnostics: {
        limit: "dsym_member_size_bytes",
        maximum_bytes: 1024 * 1024 * 1024,
        observed_bytes: 1024 * 1024 * 1024 + 1,
        member_path: oversized,
        runtime_override: false,
      },
    },
  });
});

it("rejects more than 16 DWARF directory entries with structured limit facts and no-runtime-override remediation", async () => {
  const fixture = await admissionFixture();
  for (let index = 0; index < 16; index += 1)
    await writeFile(join(fixture.directory, `extra-${String(index)}`), "");
  expect(await fixture.admit()).toMatchObject({
    ok: false,
    error: {
      reason: expect.stringContaining("more than 16 DWARF directory entries"),
      remediationAction: expect.stringContaining("no runtime override"),
      diagnostics: {
        limit: "dsym_dwarf_directory_entries",
        maximum_entries: 16,
        runtime_override: false,
      },
    },
  });
});

it("reports a placeholder target UUID before inspecting companion matches", async () => {
  const fixture = await admissionFixture(
    "00000000-0000-0000-0000-000000000000",
  );
  expect(await fixture.admit()).toMatchObject({
    ok: false,
    error: {
      reason: expect.stringContaining("no usable LC_UUID"),
      diagnostics: {
        architecture: "x86_64",
        rejection: "target_uuid_absent",
      },
    },
  });
});

it("classifies a truncated extra member at EOF as invalid-image and skips it instead of reporting traversalLimit", async () => {
  const fixture = await admissionFixture();
  const damaged = join(fixture.directory, "a-damaged-extra");
  const bytes = uuidImage("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  bytes.writeUInt32LE(2, 16); // Declares 2 load commands in a 56-byte image with 24 command bytes.
  await writeFile(damaged, bytes);
  const handle = await open(damaged, "r");
  try {
    expect(await readMachoFileUuidEntries(handle, bytes.length)).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-image",
      },
    });
  } finally {
    await handle.close();
  }
  expect(await fixture.admit()).toMatchObject({
    ok: true,
    value: {
      uuid: "11111111-2222-3333-4444-555555555555",
    },
  });
});

it.each(["/", "/."])(
  "accepts valid dSYM bundle directory spelling ending with %s in openBinaryInputSchema and parseBinaryTarget",
  async (suffix) => {
    const root = await createTestTempDirectory("rea-dsym-bundle-spelling-");
    const dsymPath = `${join(root, "selected.dSYM")}${suffix}`;
    const directory = join(
      root,
      "selected.dSYM",
      "Contents",
      "Resources",
      "DWARF",
    );
    await mkdir(directory, { recursive: true });
    const target = join(root, "target");
    const bytes = uuidImage("11111111-2222-3333-4444-555555555555");
    await writeFile(target, bytes);
    await writeFile(join(directory, "member"), bytes);

    expect(dsymPathSelectionOption.safeParse(dsymPath)).toMatchObject({
      success: true,
    });
    expect(
      openBinaryInputSchema.safeParse({ path: target, dsym_path: dsymPath }),
    ).toMatchObject({
      success: true,
    });
    for (const invalid of ["", "relative.dSYM", "/tmp/with\x00nul.dSYM"]) {
      expect(dsymPathSelectionOption.safeParse(invalid).success).toBe(false);
      expect(
        openBinaryInputSchema.safeParse({ path: target, dsym_path: invalid })
          .success,
      ).toBe(false);
    }
    expect(await parseBinaryTarget(target, { dsymPath })).toMatchObject({
      ok: true,
      value: {
        format: "mach-o",
        debugCompanion: {
          sourcePath: dsymPath,
          uuid: "11111111-2222-3333-4444-555555555555",
        },
      },
    });
  },
);

it.each(["pair-nosuffix", "pair-nosuffix/", ".dSYM", "selected.dsym"])(
  "rejects a directory named %s that is not a .dSYM bundle",
  async (bundleName) => {
    const root = await createTestTempDirectory("rea-dsym-bundle-nosuffix-");
    const folder = join(root, bundleName.replace(/\/$/u, ""));
    const dsymPath = bundleName.endsWith("/") ? `${folder}/` : folder;
    const directory = join(folder, "Contents", "Resources", "DWARF");
    await mkdir(directory, { recursive: true });
    const target = join(root, "target");
    const bytes = uuidImage("11111111-2222-3333-4444-555555555555");
    await writeFile(target, bytes);
    await writeFile(join(directory, "member"), bytes);

    const rejected = await parseBinaryTarget(target, { dsymPath });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(projectAnalysisError(rejected.error)).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        path: target,
        constraint: "debug_companion_rejected",
        reason: `dsym_path is not a .dSYM bundle directory: ${dsymPath}`,
        diagnostics: {
          dsym_path: dsymPath,
          rejection: "not_dsym_bundle",
        },
      },
    });
  },
);

it("rejects a regular file named .dSYM as not a .dSYM bundle directory", async () => {
  const root = await createTestTempDirectory("rea-dsym-regular-file-");
  const target = join(root, "target");
  const dsymFile = join(root, "regular.dSYM");
  await writeFile(target, uuidImage("11111111-2222-3333-4444-555555555555"));
  await writeFile(dsymFile, "not a directory");
  const rejected = await parseBinaryTarget(target, { dsymPath: dsymFile });
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(projectAnalysisError(rejected.error)).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      path: target,
      constraint: "debug_companion_rejected",
      reason: `dsym_path is not a .dSYM bundle directory: ${dsymFile}`,
      diagnostics: {
        dsym_path: dsymFile,
        rejection: "not_dsym_bundle",
      },
    },
  });
});

it("refuses existingProject + debugCompanion in GhidraClient.start before creating a runtime root or staging the companion", async () => {
  const fixture = await stagingFixture();
  const client = new GhidraClient({
    launcher: {
      launch: async () => {
        throw new Error(
          "existingProject + debugCompanion must fail before launching Ghidra",
        );
      },
    },
    targetPath: fixture.snapshot,
    targetSha256: "a".repeat(64),
    existingProject: true,
    debugCompanion: fixture.companion,
    providerVersion: "12.1.4",
    profileDigest: "c".repeat(64),
    logger: silentLogger,
  });
  try {
    const started = await client.start();
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.kind).toBe("admission");
    expect(started.error.cause).toBeInstanceOf(GhidraAdmissionError);
    expect(started.error.cause).toMatchObject({
      code: "existing_project_debug_companion",
    });
    expect(await readdir(fixture.runtime)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("clamps initial prefix reads to the remaining traversal budget and does not double-charge straddled window reads", async () => {
  const root = await createTestTempDirectory("rea-dsym-budget-clamp-");
  const traversalBudget = 64 * 1024 * 1024;
  const thinPath = join(root, "thin-64k");
  const thinBytes = Buffer.alloc(64 * 1024);
  uuidImage("11111111-2222-3333-4444-555555555555").copy(thinBytes, 0);
  await writeFile(thinPath, thinBytes);
  const thinHandle = await open(thinPath, "r");
  try {
    expect(
      await readMachoFileUuidEntries(thinHandle, thinBytes.length, {
        ledger: { spent: traversalBudget - 56 },
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          cpuType: 0x01000007,
          cpuSubtypeBase: 0,
          uuid: "11111111-2222-3333-4444-555555555555",
        },
      ],
    });
    expect(
      await readMachoFileUuidEntries(thinHandle, thinBytes.length, {
        ledger: { spent: traversalBudget - 55 },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "resource-limit",
      },
    });
  } finally {
    await thinHandle.close();
  }

  const fatPath = join(root, "fat-64k");
  const fatBytes = Buffer.alloc(64 * 1024);
  fatBytes.writeUInt32BE(0xcafebabe, 0);
  fatBytes.writeUInt32BE(1, 4);
  await writeFile(fatPath, fatBytes);
  const fatHandle = await open(fatPath, "r");
  try {
    expect(
      await readMachoFileUuidEntries(fatHandle, fatBytes.length, {
        ledger: { spent: traversalBudget - 6 },
      }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "resource-limit",
      },
    });
  } finally {
    await fatHandle.close();
  }

  const straddledPath = join(root, "straddled-32bit");
  const straddledSize = 65548;
  const straddledBytes = Buffer.alloc(straddledSize);
  straddledBytes.writeUInt32LE(0xfeedface, 0); // 32-bit Mach-O (28-byte header, 4-byte command alignment)
  straddledBytes.writeUInt32LE(7, 4); // x86
  straddledBytes.writeUInt32LE(2, 12);
  straddledBytes.writeUInt32LE(2, 16);
  straddledBytes.writeUInt32LE(straddledSize - 28, 20);
  straddledBytes.writeUInt32LE(0x77777777, 28);
  straddledBytes.writeUInt32LE(65524 - 28, 32); // Ends at 65524, so LC_UUID header is 65524..65532 and UUID payload straddles 65536 (65532..65548)
  straddledBytes.writeUInt32LE(0x1b, 65524);
  straddledBytes.writeUInt32LE(24, 65528);
  Buffer.from("11111111222233334444555555555555", "hex").copy(
    straddledBytes,
    65532,
  );
  await writeFile(straddledPath, straddledBytes);
  const straddledHandle = await open(straddledPath, "r");
  try {
    expect(
      await readMachoFileUuidEntries(straddledHandle, straddledBytes.length, {
        ledger: { spent: traversalBudget - straddledSize },
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          cpuType: 7,
          cpuSubtypeBase: 0,
          uuid: "11111111-2222-3333-4444-555555555555",
        },
      ],
    });
  } finally {
    await straddledHandle.close();
  }
});

const fatContainer = (
  slices: readonly {
    readonly cpuType: number;
    readonly cpuSubtype: number;
    readonly uuid: string;
  }[],
): Buffer => {
  const firstOffset = 4096;
  const stride = 4096;
  const total = firstOffset + slices.length * stride;
  const bytes = Buffer.alloc(total);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(slices.length, 4);
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    const offset = firstOffset + index * stride;
    bytes.writeUInt32BE(slice.cpuType, entry);
    bytes.writeUInt32BE(slice.cpuSubtype, entry + 4);
    bytes.writeUInt32BE(offset, entry + 8);
    bytes.writeUInt32BE(56, entry + 12);
    bytes.writeUInt32BE(12, entry + 16);
    bytes.writeUInt32LE(0xfeedfacf, offset);
    bytes.writeUInt32LE(slice.cpuType, offset + 4);
    bytes.writeUInt32LE(slice.cpuSubtype, offset + 8);
    bytes.writeUInt32LE(2, offset + 12);
    bytes.writeUInt32LE(1, offset + 16);
    bytes.writeUInt32LE(24, offset + 20);
    bytes.writeUInt32LE(0x1b, offset + 32);
    bytes.writeUInt32LE(24, offset + 36);
    Buffer.from(slice.uuid.replaceAll("-", ""), "hex").copy(bytes, offset + 40);
  });
  return bytes;
};

it("rejects a universal DWARF member with duplicate applicable slices claiming the target UUID", async () => {
  const root = await createTestTempDirectory("rea-dsym-ambiguous-member-");
  const targetUuid = "11111111-2222-3333-4444-555555555555";
  const otherUuid = "88888888-8888-8888-8888-888888888888";
  const target = join(root, "target");
  const thinImage = uuidImage(targetUuid);
  thinImage.writeUInt32LE(3, 8);
  await writeFile(target, thinImage);

  const dsymPath = join(root, "selected.dSYM");
  const dwarfDir = join(dsymPath, "Contents", "Resources", "DWARF");
  await mkdir(dwarfDir, { recursive: true });
  const ambiguousMember = join(dwarfDir, "a-universal");
  await writeFile(
    ambiguousMember,
    fatContainer([
      { cpuType: 0x01000007, cpuSubtype: 3, uuid: otherUuid },
      { cpuType: 0x01000007, cpuSubtype: 0x80000003, uuid: targetUuid },
    ]),
  );
  await writeFile(join(dwarfDir, "z-thin"), thinImage);

  const rejected = await parseBinaryTarget(target, { dsymPath });
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(projectAnalysisError(rejected.error)).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      path: target,
      constraint: "debug_companion_rejected",
      diagnostics: {
        dsym_path: dsymPath,
        member_path: ambiguousMember,
        architecture: "x86_64",
        target_uuid: targetUuid,
        rejection: "ambiguous_member_slice",
      },
    },
  });
});

it("prefers ranked subtypes and rejects duplicate target slices in direct admitDebugCompanion calls", async () => {
  const root = await createTestTempDirectory("rea-dsym-direct-target-slice-");
  const arm64Uuid = "11111111-2222-3333-4444-555555555555";
  const arm64eUuid = "22222222-2222-3333-4444-555555555555";
  const dsymPath = join(root, "selected.dSYM");
  const dwarfDir = join(dsymPath, "Contents", "Resources", "DWARF");
  await mkdir(dwarfDir, { recursive: true });
  const arm64Member = uuidImage(arm64Uuid);
  arm64Member.writeUInt32LE(0x0100000c, 4);
  arm64Member.writeUInt32LE(0, 8);
  await writeFile(join(dwarfDir, "member"), arm64Member);

  const rankedTarget = join(root, "ranked-target");
  const rankedBytes = fatContainer([
    { cpuType: 0x0100000c, cpuSubtype: 2, uuid: arm64eUuid },
    { cpuType: 0x0100000c, cpuSubtype: 0, uuid: arm64Uuid },
  ]);
  await writeFile(rankedTarget, rankedBytes);
  const rankedHandle = await open(rankedTarget, "r");
  try {
    expect(
      await admitDebugCompanion({
        dsymPath,
        targetHandle: rankedHandle,
        targetSize: rankedBytes.length,
        architecture: "arm64",
      }),
    ).toMatchObject({ ok: true, value: { uuid: arm64Uuid } });
  } finally {
    await rankedHandle.close();
  }

  const ambiguousTarget = join(root, "ambiguous-target");
  const ambiguousBytes = fatContainer([
    { cpuType: 0x0100000c, cpuSubtype: 0, uuid: arm64eUuid },
    { cpuType: 0x0100000c, cpuSubtype: 0, uuid: arm64Uuid },
  ]);
  await writeFile(ambiguousTarget, ambiguousBytes);
  const ambiguousHandle = await open(ambiguousTarget, "r");
  try {
    expect(
      await admitDebugCompanion({
        dsymPath,
        targetHandle: ambiguousHandle,
        targetSize: ambiguousBytes.length,
        architecture: "arm64",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        diagnostics: {
          dsym_path: dsymPath,
          architecture: "arm64",
          rejection: "ambiguous_target_slice",
        },
      },
    });
  } finally {
    await ambiguousHandle.close();
  }
});
