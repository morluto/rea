import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ok } from "../domain/result.js";
import type { NativeCommandRunner } from "./CommandRunner.js";
import type { NativeCallTracer } from "./LldbCallTracer.js";
import { NativeMacOSProvider } from "./NativeMacOSProvider.js";
import { withSignatureTarget } from "./SignatureTargetBinding.js";

const roots: string[] = [];
const targets: string[] = [];
const unusedRunner: NativeCommandRunner = {
  async run() {
    throw new Error("Changed target must be rejected before a command runs");
  },
};
const unusedTracer: NativeCallTracer = {
  async trace() {
    throw new Error("Signature inspection must not start a trace");
  },
  async close() {
    return ok(null);
  },
};

afterEach(async () => {
  await Promise.all(
    [...roots, ...targets].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  roots.length = 0;
  targets.length = 0;
});

const createTarget = async (
  bytes: string,
  digest = bytes,
): Promise<BinaryTarget> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-signature-target-"));
  targets.push(directory);
  const path = join(directory, "target.bin");
  await writeFile(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(digest).digest("hex"),
    kind: "executable",
    format: "mach-o",
    architecture: "arm64",
    availableArchitectures: ["arm64"],
  };
};

const createRoot = async (failedAttempts = 0) => {
  const path = await mkdtemp(join(tmpdir(), "rea-signature-root-"));
  roots.push(path);
  let attempts = 0;
  return {
    path,
    async close() {
      if (attempts++ < failedAttempts) {
        throw new Error("injected root cleanup failure");
      }
      await rm(path, { recursive: true, force: true });
    },
  };
};

it("retains a snapshot root after cleanup fails alongside a digest mismatch", async () => {
  const target = await createTarget("observed", "expected");
  const resources = new ArtifactResourceScope();
  const result = await withSignatureTarget(
    target,
    resources,
    async () => ok("unused"),
    undefined,
    () => createRoot(1),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(expect.arrayContaining(roots));
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: { diagnostics: { primary_error: { code: "artifact_changed" } } },
  });

  await resources.close();
  await expect(stat(roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns a retained cleanup failure when the next call cannot retry its root", async () => {
  const target = await createTarget("observed", "expected");
  const resources = new ArtifactResourceScope();
  const createFailingRoot = async () => {
    const path = await mkdtemp(join(tmpdir(), "rea-signature-root-sticky-"));
    roots.push(path);
    return {
      path,
      close: async () => {
        throw new Error("still blocked");
      },
    };
  };
  const first = await withSignatureTarget(
    target,
    resources,
    async () => ok("unused"),
    undefined,
    createFailingRoot,
  );
  expect(first.ok).toBe(false);
  const second = await withSignatureTarget(
    target,
    resources,
    async () => ok("must not run"),
    undefined,
    createRoot,
  );
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.error.cleanupIncomplete).toBe(true);
  expect(second.error.cleanupResources).toEqual(expect.arrayContaining(roots));
});

it("retries a retained signature root when the provider client closes", async () => {
  const target = await createTarget("observed", "expected");
  const provider = new NativeMacOSProvider(
    {},
    unusedRunner,
    "darwin",
    () => unusedTracer,
    () => createRoot(2),
  );
  const client = provider.createClient(target);
  const result = await client.execute("inspect_signature", {});

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(expect.arrayContaining(roots));
  const firstClose = await client.close();
  expect(firstClose).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true, cleanupResources: roots },
  });
  expect((await stat(roots[0]!)).isDirectory()).toBe(true);
  await expect(client.close()).resolves.toMatchObject({
    ok: true,
    value: null,
  });
  await expect(stat(roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("waits for an in-flight signature binding before provider close", async () => {
  const target = await createTarget("observed", "expected");
  let rootFactoryEntered!: () => void;
  let releaseRootFactory!: () => void;
  const entered = new Promise<void>(
    (resolve) => (rootFactoryEntered = resolve),
  );
  const gate = new Promise<void>((resolve) => (releaseRootFactory = resolve));
  const provider = new NativeMacOSProvider(
    {},
    unusedRunner,
    "darwin",
    () => unusedTracer,
    async () => {
      rootFactoryEntered();
      await gate;
      return createRoot();
    },
  );
  const client = provider.createClient(target);
  const operation = client.execute("inspect_signature", {});
  await entered;

  let closeSettled = false;
  const closing = client.close().finally(() => {
    closeSettled = true;
  });
  await Promise.resolve();
  expect(closeSettled).toBe(false);
  releaseRootFactory();
  await expect(operation).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisArtifactChangedError" },
  });
  await expect(closing).resolves.toMatchObject({ ok: true, value: null });
  expect(closeSettled).toBe(true);
  await expect(stat(roots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
});
