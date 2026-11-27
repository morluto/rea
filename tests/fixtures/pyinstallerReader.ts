import { open, type FileHandle } from "node:fs/promises";
import { PyInstallerArtifactReader } from "../../src/artifacts/PyInstallerArtifactReader.js";
import { createTestTempFile } from "./temporaryDirectory.js";

export const withPyInstallerReader = async (
  bytes: Buffer,
  run: (
    reader: PyInstallerArtifactReader,
    handle: FileHandle,
    path: string,
  ) => Promise<void>,
) => {
  const path = await createTestTempFile("rea-pyi-boundary-", "app", bytes);
  const handle = await open(path, "r");
  const reader = new PyInstallerArtifactReader(path, {
    handle,
    initial: await handle.stat(),
  });
  try {
    await run(reader, handle, path);
  } finally {
    try {
      await reader.close();
    } finally {
      await handle.close();
    }
  }
};
