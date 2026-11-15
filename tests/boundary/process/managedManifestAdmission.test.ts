import { createHash } from "node:crypto";
import { readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const admission = vi.hoisted(() => ({
  replacement: undefined as Buffer | undefined,
  snapshot: false,
  resolutionFailure: undefined as unknown,
  capacityTarget: undefined as
    | import("../../../src/domain/binaryTargetTypes.js").BinaryTarget
    | undefined,
  capacityPath: "",
  capacityHandle: undefined as
    | import("node:fs/promises").FileHandle
    | undefined,
  readCalls: 0,
  readFailure: new Error(
    "bounded capacity probe stopped before reading sparse bytes",
  ),
}));
vi.mock(
  "../../../dist/application/BinaryTargetResolver.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../src/application/BinaryTargetResolver.js")
      >();
    return {
      ...actual,
      parseBinaryTarget: async (
        ...args: Parameters<typeof actual.parseBinaryTarget>
      ) => {
        if (admission.capacityTarget !== undefined)
          return { ok: true, value: admission.capacityTarget };
        const result = await actual.parseBinaryTarget(...args);
        if (result.ok && admission.replacement !== undefined) {
          await writeFile(result.value.path, admission.replacement);
          admission.replacement = undefined;
        }
        if (!result.ok) admission.resolutionFailure = result.error;
        admission.snapshot = true;
        return result;
      },
    };
  },
);
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === admission.capacityPath) {
        admission.capacityHandle = handle;
        vi.spyOn(handle, "read").mockImplementation(async () => {
          admission.readCalls += 1;
          throw admission.readFailure;
        });
      }
      return handle;
    },
  };
});
const { verifyManagedAppManifest } = await vi.importActual<{
  verifyManagedAppManifest(
    manifest: unknown,
    manifestPath: string,
  ): Promise<unknown>;
}>("../../../scripts/verify/managed/manifest.mjs");
const { buildManagedPeFixture } = await vi.importActual<{
  buildManagedPeFixture(options: {
    methodName: string;
    ilBody: Buffer;
  }): Buffer;
}>("../../../scripts/fixtures/managed/pe.mjs");
const { inspectManagedMembersBytes } = await vi.importActual<
  typeof import("../../../src/dotnet/ManagedMemberInspector.js")
>("../../../dist/dotnet/ManagedMemberInspector.js");
const { parseBinaryTarget } = await vi.importActual<
  typeof import("../../../src/application/BinaryTargetResolver.js")
>("../../../dist/application/BinaryTargetResolver.js");
const { OwnedFileHandle } = await vi.importActual<
  typeof import("../../../src/filesystem/OwnedFileHandle.js")
>("../../../dist/filesystem/OwnedFileHandle.js");
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
afterEach(() => {
  admission.replacement = undefined;
  admission.snapshot = false;
  admission.resolutionFailure = undefined;
  admission.capacityTarget = undefined;
  admission.capacityPath = "";
  admission.capacityHandle = undefined;
  admission.readCalls = 0;
  vi.restoreAllMocks();
});

const fixture = async () => {
  const root = await createTestTempDirectory("rea-managed-manifest-admission-");
  const path = join(root, "owned.exe");
  const before = buildManagedPeFixture({
    methodName: "Before",
    ilBody: Buffer.from([0x06, 0x2a]),
  });
  const after = buildManagedPeFixture({
    methodName: "AfterX",
    ilBody: Buffer.from([0x0a, 0x00, 0x2a]),
  });
  await writeFile(path, after);
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  const method = inspectManagedMembersBytes(after, parsed.value).methods[0];
  if (method === undefined) throw new Error("Authored PE has no method");
  return {
    root,
    path,
    before,
    after,
    manifest: {
      target: { path, sha256: digest(before) },
      methods: [
        {
          token: method.token,
          signature_sha256: method.signature.raw_sha256,
          il_size: method.body.il_size,
          il_sha256: method.body.il_sha256,
          normalized_il_sha256: method.body.normalized_il_sha256,
        },
      ],
    },
  };
};

it("verifies stable authored PE bytes against independent method and digest pins", async () => {
  const value = await fixture();
  value.manifest.target.sha256 = digest(value.after);
  await expect(
    verifyManagedAppManifest(value.manifest, join(value.root, "manifest.json")),
  ).resolves.toMatchObject({
    target: { sha256: digest(value.after) },
    methods: [{ name: "AfterX", il_size: 2 }],
  });
});

it("refuses replacement method facts before attributing them to the earlier digest", async () => {
  const value = await fixture();
  await writeFile(value.path, value.before);
  admission.replacement = value.after;
  await expect(
    verifyManagedAppManifest(value.manifest, join(value.root, "manifest.json")),
  ).rejects.toMatchObject({
    _tag: "AnalysisArtifactChangedError",
    diagnostics: {
      expected_sha256: digest(value.before),
      observed_sha256: digest(value.after),
    },
  });
});

it("retains snapshot identity failure while its exact failed descriptor closes on final cleanup", async () => {
  const value = await fixture();
  await writeFile(value.path, value.before);
  admission.replacement = value.after;
  let owner: InstanceType<typeof OwnedFileHandle> | undefined;
  let attempts = 0;
  const denied = Object.assign(new Error("authored snapshot close denial"), {
    code: "EIO",
  });
  const close = OwnedFileHandle.prototype.close;
  onTestFinished(async () => {
    if (owner !== undefined && owner.handle.fd >= 0) await close.call(owner);
  });
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
    this: InstanceType<typeof OwnedFileHandle>,
  ) {
    if (admission.snapshot && owner === undefined) owner = this;
    if (this === owner && ++attempts <= 2) return Promise.reject(denied);
    return close.call(this);
  });
  const failure: unknown = await verifyManagedAppManifest(
    value.manifest,
    join(value.root, "manifest.json"),
  ).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    cleanupIncomplete: false,
    partialObservation: {
      kind: "file-snapshot-hash",
      sha256: digest(value.after),
    },
    cleanupPrimary: {
      _tag: "AnalysisArtifactChangedError",
      diagnostics: {
        expected_sha256: digest(value.before),
        observed_sha256: digest(value.after),
      },
    },
  });
  if (!(failure instanceof Error) || !(failure.cause instanceof AggregateError))
    throw new Error("Expected retained primary and cleanup failures");
  const cleanup: unknown = failure.cause.errors[1];
  if (!(cleanup instanceof Error) || !(cleanup.cause instanceof Error))
    throw new Error("Expected exact descriptor cleanup cause");
  expect(Reflect.get(cleanup.cause, "cleanupCause")).toBe(denied);
  expect(attempts).toBe(3);
  expect(owner?.handle.fd).toBe(-1);
});

it("preserves the resolver failure and retries its exact descriptor before verifier exit", async () => {
  const value = await fixture();
  let owner: InstanceType<typeof OwnedFileHandle> | undefined;
  let attempts = 0;
  const denied = Object.assign(new Error("authored target close denial"), {
    code: "EIO",
  });
  const close = OwnedFileHandle.prototype.close;
  onTestFinished(async () => {
    if (owner !== undefined && owner.handle.fd >= 0) await close.call(owner);
  });
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
    this: InstanceType<typeof OwnedFileHandle>,
  ) {
    owner ??= this;
    if (this === owner && ++attempts <= 2) return Promise.reject(denied);
    return close.call(this);
  });
  const failure: unknown = await verifyManagedAppManifest(
    value.manifest,
    join(value.root, "manifest.json"),
  ).catch((cause: unknown) => cause);
  expect(failure).toBe(admission.resolutionFailure);
  expect(failure).toMatchObject({
    _tag: "BinaryTargetError",
    cleanupIncomplete: false,
  });
  expect(attempts).toBe(3);
  expect(owner?.handle.fd).toBe(-1);
});

it.each([0x7fff_ffff, 0x8000_0000])(
  "preserves the former readFile admission boundary before sparse input reads (%i bytes)",
  async (size) => {
    const value = await fixture();
    const parsed = await parseBinaryTarget(value.path);
    if (!parsed.ok) throw parsed.error;
    value.manifest.target.sha256 = parsed.value.sha256;
    admission.capacityTarget = parsed.value;
    admission.capacityPath = value.path;
    // Sparse metadata only: no large write, digest, allocation or physical read.
    // If admission regresses, the first snapshot read throws before chunk growth.
    await truncate(value.path, size);
    if (size > 0x7fff_ffff)
      await expect(readFile(value.path)).rejects.toMatchObject({
        code: "ERR_FS_FILE_TOO_LARGE",
      });
    const failure: unknown = await verifyManagedAppManifest(
      value.manifest,
      join(value.root, "manifest.json"),
    ).catch((cause: unknown) => cause);
    if (size > 0x7fff_ffff) {
      expect(failure).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        reportedLimits: { max_snapshot_bytes: 0x7fff_ffff },
      });
      expect(admission.readCalls).toBe(0);
    } else {
      expect(failure).toBe(admission.readFailure);
      expect(admission.readCalls).toBe(1);
    }
    expect(admission.capacityHandle?.fd).toBe(-1);
  },
);
