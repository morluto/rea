import { realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectPythonPycInputSchema } from "../../src/domain/python/pythonPyc.js";
import { AnalysisInputError } from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { PythonPycProvider } from "../../src/python/PythonPycProvider.js";
import { RustBinaryProvider } from "../../src/rust/RustBinaryProvider.js";
import { pwntoolsDecoderFailure } from "../../src/native/pwntools/PwntoolsFailures.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../../src/artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../src/artifacts/readStableArtifact.js";

const selectedSymlink = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const original = join(root, "original.bin");
  const selected = join(root, "selected.bin");
  await writeFile(original, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await symlink(original, selected);
  return { selected, target: await realpath(original) };
};

/** The consumer must surface the reader's own recovery, whatever its wording. */
const expectResolvedTargetRemediation = async (
  error: unknown,
  selected: string,
  target: string,
) => {
  const refusal: unknown = await readStableArtifact(selected, 1024).catch(
    (cause: unknown) => cause,
  );
  expect(refusal).toBeInstanceOf(ArtifactReaderFailure);
  const { reason, userMessage } = refusal as ArtifactReaderFailure;
  expect(reason).toBe("path");
  expect(userMessage).toContain(target);
  expect(error).toBeInstanceOf(AnalysisInputError);
  expect(
    projectAnalysisError(error as AnalysisInputError).remediation.action,
  ).toBe(userMessage);
};

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery for a Rust symlink refusal (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-rust-symlink-");
    const result = await new RustBinaryProvider().inspect({ path: selected });
    if (result.ok) throw new Error("expected the symlink to be refused");
    await expectResolvedTargetRemediation(result.error, selected, target);
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
      await expectResolvedTargetRemediation(result.error, selected, target);
    } finally {
      await provider.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery for a pwntools artifact-read symlink refusal (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-pwntools-symlink-");
    const refusal: unknown = await readStableArtifact(selected, 1024).catch(
      (cause: unknown) => cause,
    );
    const error = pwntoolsDecoderFailure(refusal, "artifact-read", selected);
    await expectResolvedTargetRemediation(error, selected, target);
  },
);
