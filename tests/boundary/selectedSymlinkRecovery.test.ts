import { realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectPythonPycInputSchema } from "../../src/domain/python/pythonPyc.js";
import { AnalysisInputError } from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { PythonPycProvider } from "../../src/python/PythonPycProvider.js";
import { RustBinaryProvider } from "../../src/rust/RustBinaryProvider.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const selectedSymlink = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const original = join(root, "original.bin");
  const selected = join(root, "selected.bin");
  await writeFile(original, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await symlink(original, selected);
  return { selected, target: await realpath(original) };
};

const expectResolvedTargetRemediation = (error: unknown, target: string) => {
  expect(error).toBeInstanceOf(AnalysisInputError);
  expect(
    projectAnalysisError(error as AnalysisInputError).remediation.action,
  ).toBe(
    `The selected path is a symlink to ${target}. Symlinks are not followed; if that target is the intended artifact, retry with path ${target}.`,
  );
};

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery for a Rust symlink refusal (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-rust-symlink-");
    const result = await new RustBinaryProvider().inspect({ path: selected });
    if (result.ok) throw new Error("expected the symlink to be refused");
    expectResolvedTargetRemediation(result.error, target);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery for a Python pyc symlink refusal (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-pyc-symlink-");
    const provider = new PythonPycProvider();
    try {
      const result = await provider.inspect(
        inspectPythonPycInputSchema.parse({ path: selected }),
      );
      if (result.ok) throw new Error("expected the symlink to be refused");
      expectResolvedTargetRemediation(result.error, target);
    } finally {
      await provider.close();
    }
  },
);
