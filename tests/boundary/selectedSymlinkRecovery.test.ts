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
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { readAndroidMapping } from "../../src/android/AndroidMappingFile.js";
import { apkSignatureFailure } from "../../src/apkSignature/apkSignatureFailures.js";
import { historicalCaptureFailure } from "../../src/browser/history/CaptureFailures.js";
import { inspectWebNetworkCaptureInputSchema } from "../../src/domain/webNetworkCapture.js";
import { evmInterfaceFailure } from "../../src/evm/EvmoleFailures.js";
import { sqliteDatabaseFailure } from "../../src/sqlite/SqliteDatabaseFailures.js";
import { captureSqliteDatabaseSnapshot } from "../../src/sqlite/SqliteDatabaseSnapshot.js";
import { wabtFailure } from "../../src/wasm/WabtFailures.js";

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

const readerRefusal = (selected: string): Promise<unknown> =>
  readStableArtifact(selected, 1024).catch((cause: unknown) => cause);

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery through SQLite snapshot reads (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-sqlite-symlink-");
    const root = await createTestTempDirectory("rea-sqlite-snapshot-root-");
    const resources = new ArtifactResourceScope();
    const refusal: unknown = await captureSqliteDatabaseSnapshot(
      selected,
      root,
      resources,
    ).then(
      () => {
        throw new Error("expected the symlink to be refused");
      },
      (cause: unknown) => cause,
    );
    await resources.close();
    const error = sqliteDatabaseFailure(refusal, selected, "artifact-read");
    await expectResolvedTargetRemediation(error, selected, target);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery for EVM, Wasm, APK and capture path refusals (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-readers-symlink-");
    const refusal = await readerRefusal(selected);
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: selected,
      format: "har",
    });
    for (const error of [
      evmInterfaceFailure(refusal, "artifact-read", selected),
      wabtFailure(refusal, "artifact", selected),
      apkSignatureFailure(refusal, selected),
      historicalCaptureFailure(input, refusal, "capture-read"),
    ])
      await expectResolvedTargetRemediation(error, selected, target);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the resolved-target recovery for an Android mapping_path refusal (#8714)",
  async () => {
    const { selected, target } = await selectedSymlink("rea-mapping-symlink-");
    const resources = new ArtifactResourceScope();
    const result = await readAndroidMapping(
      selected,
      "inspect_android_app",
      resources,
      new AbortController().signal,
    );
    await resources.close();
    if (result.ok) throw new Error("expected the symlink to be refused");
    await expectResolvedTargetRemediation(result.error, selected, target);
  },
);
