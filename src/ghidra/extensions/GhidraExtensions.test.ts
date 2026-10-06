import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import type { BinaryTarget } from "../../domain/binaryTarget.js";
import {
  ghidraExtensionSchema,
  resolveGhidraExtensions,
  snapshotGhidraExtensions,
  validateGhidraExtensionResults,
  validateGhidraExtensionProfile,
  type GhidraExtensionResult,
} from "./GhidraExtensions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const root = async () => {
  const path = await mkdtemp(join(tmpdir(), "rea-extension-test-"));
  roots.push(path);
  return path;
};
const target: BinaryTarget = {
  path: "/tmp/native",
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  sha256: "a".repeat(64),
};
const config = (path?: string) => {
  const parsed = parseConfig(
    path === undefined ? {} : { REA_GHIDRA_NATIVEAOT_JAR: path },
  );
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const artifact = async () => {
  const directory = await root();
  const path = join(directory, "fixture.jar");
  const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2, 3]);
  await writeFile(path, bytes);
  const resolved = await resolveGhidraExtensions(config(path), target, "linux");
  if (!resolved.ok || resolved.value[0] === undefined)
    throw new Error("expected fixture artifact");
  return { extension: resolved.value[0], bytes, path };
};
const result = (sha256: string): GhidraExtensionResult => ({
  id: "nativeaot",
  sha256,
  status: "not_applicable",
  reason: "No matching directory",
  result: {
    id: "nativeaot",
    integration_api: 1,
    source_revision: "effeb734fc570c32650f88b159608979dc7b423e",
    source_revision_authority: "build-reported-unattested",
    status: "not_applicable",
    reason: "No matching directory",
    method_tables: 0,
    diagnostics: [],
  },
});

describe("optional Ghidra extension boundary", () => {
  it("keeps ordinary profiles free of unconfigured extensions", async () => {
    expect(await resolveGhidraExtensions(config(), target, "linux")).toEqual({
      ok: true,
      value: [],
    });
  });
  it("validates configuration paths rather than ignoring an unsupported value", () => {
    expect(parseConfig({ REA_GHIDRA_NATIVEAOT_JAR: "relative.jar" }).ok).toBe(
      false,
    );
  });
  it("commits the actual regular artifact bytes and caller path", async () => {
    const { extension, bytes, path } = await artifact();
    expect(extension).toMatchObject({
      configured_path: path,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integration_api: 1,
    });
  });
  it("snapshots identical bytes exclusively into the private runtime", async () => {
    const { extension, bytes } = await artifact();
    const runtime = await root();
    const snapshots = await snapshotGhidraExtensions([extension], runtime);
    expect(snapshots[0]?.path).toBe(join(runtime, "extensions/nativeaot.jar"));
    expect(await readFile(join(runtime, "extensions/nativeaot.jar"))).toEqual(
      bytes,
    );
    await expect(
      snapshotGhidraExtensions([extension], runtime),
    ).rejects.toThrow();
  });
  it("rejects artifact changes after the profile commitment", async () => {
    const { extension, path } = await artifact();
    await writeFile(path, Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9, 9]));
    await expect(
      snapshotGhidraExtensions([extension], await root()),
    ).rejects.toThrow("digest differs");
  });
  it("rejects nonexistent, empty and non-JAR artifacts with useful reasons", async () => {
    const directory = await root();
    for (const bytes of [Buffer.alloc(0), Buffer.from("invalid jar")]) {
      const path = join(directory, "invalid.jar");
      await writeFile(path, bytes);
      const resolved = await resolveGhidraExtensions(
        config(path),
        target,
        "linux",
      );
      expect(resolved.ok).toBe(false);
      if (!resolved.ok)
        expect(resolved.error).toMatchObject({
          diagnostics: { path, extension: "nativeaot" },
        });
    }
    expect(
      (
        await resolveGhidraExtensions(
          config(join(directory, "absent.jar")),
          target,
          "linux",
        )
      ).ok,
    ).toBe(false);
  });
  it("rejects unsupported hosts and target architectures before opening files", async () => {
    expect(
      (await resolveGhidraExtensions(config("/absent.jar"), target, "win32"))
        .ok,
    ).toBe(false);
    expect(
      (
        await resolveGhidraExtensions(
          config("/absent.jar"),
          {
            ...target,
            architecture: "arm64",
            availableArchitectures: ["arm64"],
          },
          "linux",
        )
      ).ok,
    ).toBe(false);
  });
  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without requiring another process to open its writer",
    async () => {
      const path = join(await root(), "not-a-jar.fifo");
      await promisify(execFile)("mkfifo", [path]);
      let writerRequired = false;
      let rescueTimer: ReturnType<typeof setTimeout> | undefined;
      // Release a broken blocking-open implementation so regression failures
      // do not strand a libuv filesystem worker. Success needs no FIFO peer.
      const rescue = new Promise<void>((resolve) => {
        rescueTimer = setTimeout(() => {
          writerRequired = true;
          void open(path, constants.O_WRONLY | constants.O_NONBLOCK)
            .then((file) => file.close())
            .then(resolve, () => resolve());
        }, 1000);
      });
      try {
        const resolved = await resolveGhidraExtensions(
          config(path),
          target,
          "linux",
        );
        expect(resolved.ok).toBe(false);
        if (!resolved.ok)
          expect(resolved.error).toMatchObject({
            diagnostics: { reason: expect.stringContaining("regular JAR") },
          });
        expect(writerRequired).toBe(false);
      } finally {
        clearTimeout(rescueTimer);
        if (writerRequired) await rescue;
      }
    },
  );
  it("honors cancellation before artifact I/O", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolved = await resolveGhidraExtensions(
      config("/absent.jar"),
      target,
      "linux",
      controller.signal,
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(resolved.error._tag).toBe("AnalysisCancelledError");
  });
  it("refuses traversal identities in an imported extension profile", () => {
    expect(
      ghidraExtensionSchema.safeParse({
        id: "../escape",
        path: "/fixture.jar",
        configured_path: "/fixture.jar",
        sha256: "a".repeat(64),
        integration_api: 1,
        entry_class: "ignored",
      }).success,
    ).toBe(false);
  });
});

describe("Ghidra extension profile and producer validation", () => {
  it("requires exact inventory, artifact digest and consistent producer status", async () => {
    const { extension } = await artifact();
    const valid = result(extension.sha256);
    expect(validateGhidraExtensionResults([extension], [valid])).toBeNull();
    expect(validateGhidraExtensionResults([extension], [])).not.toBeNull();
    expect(validateGhidraExtensionResults([], [valid])).not.toBeNull();
    expect(
      validateGhidraExtensionResults([extension], [valid, valid]),
    ).not.toBeNull();
    expect(
      validateGhidraExtensionResults(
        [extension],
        [{ ...valid, sha256: "b".repeat(64) }],
      ),
    ).not.toBeNull();
    expect(
      validateGhidraExtensionResults(
        [extension],
        [{ ...valid, status: "complete" }],
      ),
    ).not.toBeNull();
  });
  it("requires matching explicit configuration for imported executable profiles", async () => {
    const { extension, path } = await artifact();
    expect(
      validateGhidraExtensionProfile(
        [extension],
        config(path),
        target,
        "linux",
      ),
    ).toBeNull();
    expect(
      validateGhidraExtensionProfile([extension], config(), target, "linux"),
    ).not.toBeNull();
    expect(
      validateGhidraExtensionProfile(
        [extension],
        config(path),
        target,
        "darwin",
      ),
    ).not.toBeNull();
    expect(
      validateGhidraExtensionProfile(
        [{ ...extension, entry_class: "arbitrary.Code" }],
        config(path),
        target,
        "linux",
      ),
    ).not.toBeNull();
    expect(
      validateGhidraExtensionProfile(
        [{ ...extension, configured_path: "/another.jar" }],
        config(path),
        target,
        "linux",
      ),
    ).not.toBeNull();
  });
  it("does not classify PE/CLI or ReadyToRun as NativeAOT", async () => {
    const resolved = await resolveGhidraExtensions(
      config("/absent.jar"),
      { ...target, format: "pe", managed: true, executableRole: "application" },
      "linux",
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(resolved.error).toMatchObject({
        diagnostics: {
          reason: expect.stringContaining("inspect_managed_artifact"),
        },
      });
  });
  it("does not substitute another artifact under an unchanged configured path", async () => {
    const first = await artifact();
    const second = await artifact();
    await expect(
      snapshotGhidraExtensions(
        [{ ...second.extension, configured_path: first.path }],
        await root(),
      ),
    ).rejects.toThrow("resolved path differs");
  });
  it("rejects unregistered descriptors before snapshot filesystem writes", async () => {
    const { extension } = await artifact();
    const runtime = await root();
    await expect(
      snapshotGhidraExtensions([{ ...extension, id: "unknown" }], runtime),
    ).rejects.toThrow("Unregistered");
  });
});

describe("Ghidra extension recovery coverage", () => {
  it("validates positive recovery, measured partial coverage and distinct table identities", async () => {
    const { extension } = await artifact();
    const baseline = result(extension.sha256);
    const positive: GhidraExtensionResult = {
      ...baseline,
      status: "complete",
      reason: null,
      result: {
        ...baseline.result,
        status: "complete",
        reason: null,
        method_tables: 1,
        header_address: "0x401000",
        discovery: "signature-heuristic",
        format_major: 9,
        format_minor: 1,
        types: [
          {
            address: "0x402000",
            type: "/NativeAOT/MethodTables/Class_00402000_MT",
          },
        ],
        derived_memory: {
          address: "0x402000",
          size_bytes: 64,
          sha256: "a".repeat(64),
          file_offset: null,
        },
        coverage: {
          frozen_object_candidates: 1,
          frozen_objects_annotated: 1,
          basis: "rehydrated-pointer-candidates-and-committed-instance-types",
        },
      },
    };
    expect(validateGhidraExtensionResults([extension], [positive])).toBeNull();
    const incomplete = {
      ...positive,
      result: {
        ...positive.result,
        coverage: {
          frozen_object_candidates: 2,
          frozen_objects_annotated: 1,
          basis: "rehydrated-pointer-candidates-and-committed-instance-types",
        },
      },
    };
    expect(
      validateGhidraExtensionResults([extension], [incomplete]),
    ).not.toBeNull();
    expect(
      validateGhidraExtensionResults(
        [extension],
        [
          {
            ...incomplete,
            status: "partial",
            result: { ...incomplete.result, status: "partial" },
          },
        ],
      ),
    ).toBeNull();
    expect(
      validateGhidraExtensionResults(
        [extension],
        [{ ...positive, result: { ...positive.result, discovery: null } }],
      ),
    ).not.toBeNull();
  });
  it("preserves real loader failures without requiring a successful analyzer report", async () => {
    const { extension } = await artifact();
    const reason = "Extension loading/analysis failed: ClassNotFoundException";
    expect(
      validateGhidraExtensionResults(
        [extension],
        [
          {
            id: "nativeaot",
            sha256: extension.sha256,
            status: "failed",
            reason,
            result: { loader_failure: reason },
          },
        ],
      ),
    ).toBeNull();
  });
  it("does not accept complete recovery without format and byte identities", async () => {
    const { extension } = await artifact();
    const incomplete = result(extension.sha256);
    incomplete.result.status = "complete";
    incomplete.result.reason = null;
    expect(
      validateGhidraExtensionResults(
        [extension],
        [{ ...incomplete, status: "complete", reason: null }],
      ),
    ).not.toBeNull();
  });
});
