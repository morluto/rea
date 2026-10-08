import { createHash } from "node:crypto";
import { rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  dyldCacheFixture,
  type CacheFixture,
} from "../../../src/artifacts/apple/DyldSharedCache.fixture.js";
import {
  FILE_TYPE,
  buildVersionCommand,
  LC,
  dylibCommand,
  dylibUseCommand,
  machoImage,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import {
  inspectDyldSharedCache,
  inspectDyldSharedCacheEvidence,
} from "../../../src/application/apple/DyldSharedCacheService.js";
import { dyldSharedCacheResultSchema } from "../../../src/domain/apple/dyldSharedCache.js";
import { traceDylibResolution } from "../../../src/artifacts/apple/DylibResolutionReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("rejects a directory and overlapping combined VM mappings with specific reasons", async () => {
  const directory = await createTestTempDirectory("rea-cache-invalid-regions-");
  expect(await inspectDyldSharedCache({ cache_path: directory })).toMatchObject(
    { ok: false, error: { reason: "path" } },
  );
  const fixture = dyldCacheFixture(IMAGES);
  const original = fixture.subcaches[0];
  if (original === undefined) throw new Error("missing subcache fixture");
  const subcache = Buffer.from(original.bytes);
  const main = Buffer.from(fixture.main);
  const mainTable = main.readUInt32LE(0x10);
  const subTable = subcache.readUInt32LE(0x10);
  subcache.writeBigUInt64LE(main.readBigUInt64LE(mainTable), subTable);
  // Keep the declared VM offset consistent so the failure is the overlap.
  main.writeBigUInt64LE(0n, main.readUInt32LE(0x188) + 16);
  const path = await writeCache({
    ...fixture,
    main,
    subcaches: [{ ...original, bytes: subcache }],
  });
  const result = await inspectDyldSharedCache({ cache_path: path });
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "format", detail: expect.stringContaining("overlap") },
  });
});

const dylib = (installName: string, dependencies: readonly Uint8Array[] = []) =>
  machoImage({
    fileType: FILE_TYPE.dylib,
    commands: [dylibCommand(LC.ID_DYLIB, installName), ...dependencies],
  });

it("rejects a same-UUID subcache whose architecture or VM offset disagrees", async () => {
  const fixture = dyldCacheFixture(IMAGES);
  const original = fixture.subcaches[0];
  if (original === undefined) throw new Error("missing subcache fixture");
  const wrongArchitecture = Buffer.from(original.bytes);
  wrongArchitecture.write("dyld_v1  x86_64".padEnd(15, " "), 0, "latin1");
  const architecturePath = await writeCache({
    ...fixture,
    subcaches: [{ ...original, bytes: wrongArchitecture }],
  });
  expect(
    await inspectDyldSharedCache({ cache_path: architecturePath }),
  ).toMatchObject({
    ok: false,
    error: {
      reason: "format",
      detail: expect.stringContaining("does not match"),
    },
  });
  const main = Buffer.from(fixture.main);
  main.writeBigUInt64LE(0n, main.readUInt32LE(0x188) + 16);
  const offsetPath = await writeCache({ ...fixture, main });
  expect(
    await inspectDyldSharedCache({ cache_path: offsetPath }),
  ).toMatchObject({
    ok: false,
    error: { reason: "format", detail: expect.stringContaining("disagrees") },
  });
});

it("does not resolve a cached path whose bytes are not a Mach-O image", async () => {
  const path = await writeCache(
    dyldCacheFixture([
      { path: "/usr/lib/libSystem.B.dylib", bytes: Buffer.alloc(64, 0) },
    ]),
  );
  const targetPath = join(dirname(path), "tool");
  const bytes = machoImage({
    fileType: FILE_TYPE.execute,
    commands: [
      buildVersionCommand(1),
      dylibCommand(LC.LOAD_DYLIB, "/usr/lib/libSystem.B.dylib"),
    ],
  });
  await writeFile(targetPath, bytes);
  const trace = await traceDylibResolution({
    rootPath: dirname(path),
    targetPath,
    targetSha256: createHash("sha256").update(bytes).digest("hex"),
    enumerateRoots: false,
    parameters: { shared_cache: path },
  });
  expect(trace.edges[0]?.candidates[0]?.outcome).toBe("undetermined");
  expect(trace.edges[0]?.resolution).toEqual({
    status: "undetermined",
    image: null,
  });
  expect(trace.coverage.unverified_shared_cache_images).toEqual([
    "/usr/lib/libSystem.B.dylib",
  ]);
  expect(trace.images.map(({ path: image }) => image)).not.toContain(
    "/usr/lib/libSystem.B.dylib",
  );
});

it("rejects unmapped images when no unavailable subcache can explain the address", async () => {
  const fixture = dyldCacheFixture(IMAGES);
  const main = Buffer.from(fixture.main);
  main.writeBigUInt64LE(0x700000000n, main.readUInt32LE(0x1c0));
  const path = await writeCache({ ...fixture, main });
  expect(await inspectDyldSharedCache({ cache_path: path })).toMatchObject({
    ok: false,
    error: {
      reason: "format",
      detail: expect.stringContaining("unmapped image address"),
    },
  });
});

const writeCache = async (
  fixture: CacheFixture,
  name = "dyld_shared_cache_arm64e",
): Promise<string> => {
  const directory = await createTestTempDirectory("rea-dyld-cache-");
  const base = join(directory, "dyld_shared_cache_arm64e");
  await writeFile(join(directory, name), fixture.main);
  for (const { suffix, bytes } of fixture.subcaches)
    await writeFile(`${base}${suffix}`, bytes);
  return join(directory, name);
};

const IMAGES = [
  {
    path: "/usr/lib/libSystem.B.dylib",
    bytes: dylib("/usr/lib/libSystem.B.dylib", [
      dylibCommand(LC.REEXPORT_DYLIB, "/usr/lib/system/libcache.dylib"),
    ]),
  },
  {
    path: "/usr/lib/swift/libswiftCore.dylib",
    bytes: dylib("/usr/lib/swift/libswiftCore.dylib", [
      dylibUseCommand(LC.LOAD_DYLIB, "/usr/lib/libSystem.B.dylib", 0x4 | 0x8),
    ]),
    inSubcache: true,
  },
];

describe("dyld shared cache inspection", () => {
  it("reads the header, subcaches, image list and cached load commands", async () => {
    const path = await writeCache(dyldCacheFixture(IMAGES));
    const result = await inspectDyldSharedCache({
      cache_path: path,
      images: ["/usr/lib/swift/libswiftCore.dylib", "/usr/lib/missing.dylib"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cache = dyldSharedCacheResultSchema.parse(result.value);
    expect(cache).toMatchObject({
      architecture: "arm64e",
      platform: { id: 1, name: "macos" },
      os_version: "26.6.0",
      shared_region: { start: "0x180000000", size: "0x20000000" },
      images_total: 2,
      coverage: { status: "complete", unreadable_subcaches: [] },
    });
    expect(cache.subcaches).toEqual([
      expect.objectContaining({
        suffix: ".01",
        status: "present",
        vm_offset: "0x10000000",
      }),
    ]);
    expect(cache.images.map(({ path: image }) => image)).toEqual(
      IMAGES.map(({ path: image }) => image),
    );
    const [swift, missing] = cache.inspected_images;
    expect(swift).toMatchObject({ status: "parsed", file: ".01" });
    expect(swift?.slices[0]?.dependencies).toEqual([
      expect.objectContaining({
        install_name: "/usr/lib/libSystem.B.dylib",
        encoding: "dylib_use_command",
        upward: true,
        delayed_init: true,
      }),
    ]);
    expect(missing).toEqual({
      path: "/usr/lib/missing.dylib",
      status: "absent",
      address: null,
      file: null,
      reason: null,
      slices: [],
    });
  });

  it("reports missing and mismatched subcaches as partial coverage", async () => {
    const mismatched = await writeCache(
      dyldCacheFixture(IMAGES, { subcacheUuidSeed: 9 }),
    );
    const result = await inspectDyldSharedCache({
      cache_path: mismatched,
      images: ["/usr/lib/swift/libswiftCore.dylib"],
    });
    expect(result.ok && result.value).toMatchObject({
      subcaches: [{ suffix: ".01", status: "uuid-mismatch" }],
      inspected_images: [{ status: "unmapped" }],
      coverage: { status: "partial", unreadable_subcaches: [".01"] },
    });
    const missing = await writeCache(dyldCacheFixture(IMAGES));
    await rm(`${missing}.01`);
    const without = await inspectDyldSharedCache({ cache_path: missing });
    expect(without.ok && without.value.subcaches[0]).toMatchObject({
      status: "missing",
      observed_uuid: null,
    });
  });

  it("finds a development cache's subcaches beside its base name", async () => {
    const path = await writeCache(
      dyldCacheFixture(IMAGES),
      "dyld_shared_cache_arm64e.development",
    );
    const result = await inspectDyldSharedCache({
      cache_path: path,
      images: ["/usr/lib/swift/libswiftCore.dylib"],
    });
    expect(result.ok && result.value).toMatchObject({
      subcaches: [{ suffix: ".01", status: "present" }],
      inspected_images: [{ status: "parsed", file: ".01" }],
    });
  });

  it("reads legacy single-file headers without later fields", async () => {
    const path = await writeCache(
      dyldCacheFixture(IMAGES.slice(0, 1), { legacy: true }),
    );
    const result = await inspectDyldSharedCache({
      cache_path: path,
      images: ["/usr/lib/libSystem.B.dylib"],
    });
    expect(result.ok && result.value).toMatchObject({
      platform: null,
      os_version: null,
      subcaches: [],
      images_total: 1,
      inspected_images: [{ status: "parsed" }],
    });
  });

  it("separates malformed input, missing files and non-cache files", async () => {
    expect(await inspectDyldSharedCache({ images: [] })).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    const directory = await createTestTempDirectory("rea-dyld-cache-bad-");
    expect(
      await inspectDyldSharedCache({ cache_path: join(directory, "absent") }),
    ).toMatchObject({ ok: false, error: { reason: "path" } });
    const notCache = join(directory, "not-a-cache");
    await writeFile(notCache, Buffer.alloc(64, 0x41));
    expect(
      await inspectDyldSharedCache({ cache_path: notCache }),
    ).toMatchObject({
      ok: false,
      error: { reason: "format" },
    });
  });

  it("wraps the observation as Evidence about the main cache file", async () => {
    const path = await writeCache(dyldCacheFixture(IMAGES));
    const evidence = await inspectDyldSharedCacheEvidence({ cache_path: path });
    expect(evidence.ok && evidence.value).toMatchObject({
      operation: "inspect_dyld_shared_cache",
      subject: { local_path: path, format: "file" },
      confidence: "observed",
    });
  });
});

it("retains a relative caller-selected cache path in trace and inspection metadata", async () => {
  const path = await writeCache(dyldCacheFixture(IMAGES));
  const selected = relative(process.cwd(), path);
  const targetPath = join(dirname(path), "tool");
  const bytes = machoImage({
    fileType: FILE_TYPE.execute,
    commands: [
      buildVersionCommand(1),
      dylibCommand(LC.LOAD_DYLIB, "/usr/lib/libSystem.B.dylib"),
    ],
  });
  await writeFile(targetPath, bytes);
  const trace = await traceDylibResolution({
    rootPath: dirname(path),
    targetPath,
    targetSha256: createHash("sha256").update(bytes).digest("hex"),
    enumerateRoots: false,
    parameters: { shared_cache: selected },
  });
  expect(trace.shared_cache?.path).toBe(selected);
  expect(trace.shared_cache?.main_file_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(trace.edges[0]?.resolution.status).toBe("shared-cache");
  const inspected = await inspectDyldSharedCacheEvidence({
    cache_path: selected,
  });
  if (!inspected.ok) throw inspected.error;
  expect(inspected.value.parameters).toMatchObject({ cache_path: selected });
});

it("discovers companions beside a symlink target while preserving selected metadata", async () => {
  const path = await writeCache(
    dyldCacheFixture(IMAGES),
    "dyld_shared_cache_arm64e.development",
  );
  const aliases = await createTestTempDirectory("rea-cache-alias-");
  const alias = join(aliases, "selected-cache");
  await symlink(path, alias);
  const result = await inspectDyldSharedCache({
    cache_path: alias,
    images: ["/usr/lib/swift/libswiftCore.dylib"],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    cache_path: alias,
    subcaches: [{ status: "present", suffix: ".01" }],
    inspected_images: [{ status: "parsed", file: ".01" }],
    coverage: { status: "complete", unreadable_subcaches: [] },
  });
});

it.each([
  [2, 7],
  [3, 8],
  [4, 9],
  [11, 12],
])(
  "decodes simulator cache family %i into platform %i and retains raw metadata",
  async (raw, normalized) => {
    const fixture = dyldCacheFixture(IMAGES.slice(0, 1));
    const main = Buffer.from(fixture.main);
    main.writeUInt32LE(raw, 0xd8);
    main.writeUInt32LE(1 << 9, 0xdc);
    const path = await writeCache({ ...fixture, main });
    const result = await inspectDyldSharedCache({ cache_path: path });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      platform: { id: normalized },
      header_platform: { id: raw },
      simulator: true,
    });
    const targetPath = join(dirname(path), "simulator-tool");
    const bytes = machoImage({
      fileType: FILE_TYPE.execute,
      commands: [
        buildVersionCommand(normalized),
        dylibCommand(LC.LOAD_DYLIB, "/usr/lib/libSystem.B.dylib"),
      ],
    });
    await writeFile(targetPath, bytes);
    const trace = await traceDylibResolution({
      rootPath: dirname(path),
      targetPath,
      targetSha256: createHash("sha256").update(bytes).digest("hex"),
      enumerateRoots: false,
      parameters: { shared_cache: path },
    });
    expect(trace.edges[0]?.resolution.status).toBe("shared-cache");
  },
);
