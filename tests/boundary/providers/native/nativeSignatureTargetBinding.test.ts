import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  withSignatureTarget,
  verifySignatureTarget,
} from "../../../../src/native/SignatureTargetBinding.js";
import {
  NativeCommandFailure,
  XcrunCommandRunner,
  type NativeCommandRunner,
} from "../../../../src/native/CommandRunner.js";
import { inspectSignatureSchema } from "../../../../src/domain/native/nativeInspection.js";
import { err } from "../../../../src/domain/result.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import {
  NativeFixtureRunner,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const CONTENT = "registered executable bytes";
const fixture = async () => {
  const directory = await createTestTempDirectory("rea-signature-binding-");
  const path = join(directory, "program");
  await writeFile(path, CONTENT);
  return {
    directory,
    path,
    target: await nativeMachoTargetForFile(path),
  };
};

class Captures extends NativeFixtureRunner {
  calls = 0;
  constructor(
    private readonly onCapture?: (args: readonly string[]) => Promise<void>,
  ) {
    super();
  }
  override async run(tool: string, args: readonly string[]) {
    this.calls += 1;
    await this.onCapture?.(args);
    return super.run(tool, args);
  }
}

describe("native signature target identity", () => {
  it("inspects an unchanged registered executable", async () => {
    const { target } = await fixture();
    const result = await new NativeMacOSProvider(new Captures(), "darwin")
      .createClient(target)
      .execute("inspect_signature", {});
    expect(result.ok && result.value.result).toMatchObject({
      signed: true,
      identifier: "com.example.fixture",
    });
  });

  it.each(["changed", "missing", "directory", "symlink"] as const)(
    "rejects a %s target before commands run",
    async (replacement) => {
      const { path, target } = await fixture();
      if (replacement === "changed") await writeFile(path, "replacement bytes");
      else {
        await rm(path);
        if (replacement === "directory") await mkdir(path);
        if (replacement === "symlink") {
          await symlink(join(path, "missing"), path);
        }
      }
      const runner = new Captures();
      const result = await new NativeMacOSProvider(runner, "darwin")
        .createClient(target)
        .execute("inspect_signature", {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected target-change failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "artifact_changed",
        details: { path },
      });
      expect(runner.calls).toBe(0);
    },
  );

  it.each(["replace", "remove", "rewrite"] as const)(
    "rejects %s after capturing signature metadata",
    async (change) => {
      const { path, target } = await fixture();
      const runner = new Captures(async (args) => {
        if (!args.includes("--entitlements")) return;
        if (change === "remove") await rm(path);
        else if (change === "rewrite") await writeFile(path, CONTENT);
        else {
          const replacement = `${path}.replacement`;
          await writeFile(replacement, CONTENT);
          await rename(replacement, path);
        }
      });
      const result = await new NativeMacOSProvider(runner, "darwin")
        .createClient(target)
        .execute("inspect_signature", {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected target-change failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "artifact_changed",
        details: { path },
      });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "preserves read permission denial before commands",
    async () => {
      const { path, target } = await fixture();
      await chmod(path, 0);
      const runner = new Captures();
      try {
        const result = await new NativeMacOSProvider(runner, "darwin")
          .createClient(target)
          .execute("inspect_signature", {});
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected access denial");
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "access_denied",
          details: { path },
        });
        expect(runner.calls).toBe(0);
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "preserves permission denial during final version lookup",
    async () => {
      const { directory, path, target } = await fixture();
      const runner = new Captures(async (args) => {
        if (args.includes("--entitlements")) await chmod(directory, 0);
      });
      try {
        const result = await new NativeMacOSProvider(runner, "darwin")
          .createClient(target)
          .execute("inspect_signature", {});
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected access denial");
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "access_denied",
          details: { path },
        });
      } finally {
        await chmod(directory, 0o700);
      }
    },
  );
});

it.each([
  ["display", "result"],
  ["requirements", "result"],
  ["entitlements", "result"],
  ["slice", "result"],
  ["display", "throw"],
  ["requirements", "diagnostic"],
] as const)(
  "reports a removed target before the %s capture's %s failure can hide it",
  async (stage, failure) => {
    const { path, target } = await fixture();
    const replay = new NativeFixtureRunner();
    const unsigned = new NativeFixtureRunner(
      { codesign: "code object is not signed at all\n" },
      1,
    );
    let failed = false;
    const runner: NativeCommandRunner = {
      async run(tool, args) {
        const slice = args.includes("-a");
        const selected =
          stage === "slice"
            ? slice
            : stage === "requirements"
              ? args.includes("-r-")
              : stage === "entitlements"
                ? args.includes("--entitlements")
                : !args.includes("-r-") &&
                  !args.includes("--entitlements") &&
                  !slice;
        if (selected) {
          failed = true;
          await rm(path);
          if (failure === "throw")
            throw new Error("codesign target disappeared");
          if (failure === "diagnostic")
            return new NativeFixtureRunner(
              { codesign: "invalid or unsupported format\n" },
              1,
            ).run(tool, args);
          return err(new NativeCommandFailure(tool, "nonzero-exit", 1));
        }
        if (stage === "slice" && args.includes("-r-"))
          return unsigned.run(tool, args);
        return replay.run(tool, args);
      },
    };
    const result = await new NativeMacOSProvider(runner, "darwin")
      .createClient(target)
      .execute("inspect_signature", {});
    expect(failed).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisArtifactChangedError" },
    });
  },
);

it("rejects an intermediate replacement before a later capture can restore the original inode", async () => {
  const { path, target } = await fixture();
  const original = `${path}.original`;
  const runner = new Captures(async (args) => {
    if (args.includes("-r-")) {
      await rename(path, original);
      await writeFile(path, "different executable");
    } else if (args.includes("--entitlements")) {
      await rm(path);
      await rename(original, path);
    }
  });
  const result = await new NativeMacOSProvider(runner, "darwin")
    .createClient(target)
    .execute("inspect_signature", {});
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisArtifactChangedError" },
  });
});

it("returns typed cancellation during target acquisition before commands run", async () => {
  const { path } = await fixture();
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 42));
  const target = await nativeMachoTargetForFile(path);
  const controller = new AbortController();
  const runner = new Captures();
  const pending = new NativeMacOSProvider(runner, "darwin")
    .createClient(target)
    .execute("inspect_signature", {}, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(!result.ok && projectAnalysisError(result.error).code).toBe(
    "cancelled",
  );
  expect(runner.calls).toBe(0);
});

it("returns typed cancellation at binding entry and final verification", async () => {
  const { target } = await fixture();
  const signal = AbortSignal.abort();
  await expect(
    withSignatureTarget(
      target,
      async () => {
        throw new Error("Cancelled acquisition must not invoke inspection");
      },
      signal,
    ),
  ).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  await withSignatureTarget(target, async (binding) => {
    const result = await verifySignatureTarget(target, binding, signal);
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    return result;
  });
});

it("preserves cancellation after a capture instead of classifying it as invalid output", async () => {
  const { target } = await fixture();
  const controller = new AbortController();
  const runner = new Captures(async () => {
    controller.abort();
  });
  const result = await new NativeMacOSProvider(runner, "darwin")
    .createClient(target)
    .execute("inspect_signature", {}, { signal: controller.signal });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it.each(["success", "failure", "cancellation", "throw"] as const)(
  "releases the verified snapshot after %s",
  async (outcome) => {
    const { target } = await fixture();
    const controller = new AbortController();
    let snapshotPath: string | undefined;
    const runner: NativeCommandRunner = {
      async run(tool, args) {
        snapshotPath = args.at(-1);
        if (snapshotPath === undefined)
          throw new Error("Missing command target");
        expect(snapshotPath).not.toBe(target.path);
        expect(await readFile(snapshotPath, "utf8")).toBe(CONTENT);
        if (outcome === "throw") throw new Error("Unexpected native failure");
        if (outcome === "failure")
          return err(new NativeCommandFailure(tool, "io"));
        if (outcome === "cancellation") controller.abort();
        return new NativeFixtureRunner().run(tool, args);
      },
    };
    const result = await new NativeMacOSProvider(runner, "darwin")
      .createClient(target)
      .execute("inspect_signature", {}, { signal: controller.signal });
    expect(result.ok).toBe(outcome === "success");
    if (snapshotPath === undefined)
      throw new Error("Expected snapshot capture");
    await expect(lstat(dirname(snapshotPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("copies and hashes the same bytes across multiple snapshot chunks", async () => {
  const { path } = await fixture();
  const bytes = Buffer.alloc(128 * 1024 + 13, 42);
  await writeFile(path, bytes);
  const target = await nativeMachoTargetForFile(path);
  await withSignatureTarget(target, async (binding) => {
    expect(await readFile(binding.snapshotPath)).toEqual(bytes);
    return verifySignatureTarget(target, binding);
  });
});

it("cleans the private snapshot when inspection throws", async () => {
  const { target } = await fixture();
  let snapshotPath: string | undefined;
  await expect(
    withSignatureTarget(target, async (binding) => {
      snapshotPath = binding.snapshotPath;
      throw new Error("Invalid parsed output");
    }),
  ).rejects.toThrow("Invalid parsed output");
  if (snapshotPath === undefined) throw new Error("Expected snapshot");
  await expect(lstat(dirname(snapshotPath))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.skipIf(process.platform !== "darwin")(
  "keeps real codesign bound to registered bytes during an ancestor directory swap",
  async () => {
    const root = await createTestTempDirectory("rea-signature-swap-");
    const selected = join(root, "selected");
    const replacement = join(root, "replacement");
    const saved = join(root, "saved");
    await mkdir(selected);
    await mkdir(replacement);
    const path = join(selected, "program");
    const replacementPath = join(replacement, "program");
    const run = promisify(execFile);
    for (const [program, identifier] of [
      [path, "rea.original"],
      [replacementPath, "rea.replacement"],
    ] as const) {
      await copyFile("/usr/bin/true", program);
      await run("/usr/bin/codesign", [
        "-s",
        "-",
        "-f",
        "--identifier",
        identifier,
        program,
      ]);
    }
    const target = await nativeMachoTargetForFile(path);
    const real = new XcrunCommandRunner();
    let capturedPath: string | undefined;
    const runner: NativeCommandRunner = {
      async run(tool, args, options) {
        capturedPath = args.at(-1);
        await rename(selected, saved);
        await rename(replacement, selected);
        try {
          expect(await readFile(path)).not.toEqual(
            await readFile(join(saved, "program")),
          );
          return await real.run(tool, args, options);
        } finally {
          await rename(selected, replacement);
          await rename(saved, selected);
        }
      },
    };
    const result = await new NativeMacOSProvider(runner, "darwin")
      .createClient(target)
      .execute("inspect_signature", {});
    expect(result.ok && result.value.result).toMatchObject({
      signed: true,
      identifier: "rea.original",
    });
    if (!result.ok) throw result.error;
    expect(
      inspectSignatureSchema
        .parse(result.value.result)
        .provenance.map(({ command }) => command.at(-1)),
    ).toEqual(["$ARTIFACT", "$ARTIFACT", "$ARTIFACT"]);
    if (capturedPath === undefined)
      throw new Error("Expected codesign invocation");
    await expect(lstat(dirname(capturedPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
