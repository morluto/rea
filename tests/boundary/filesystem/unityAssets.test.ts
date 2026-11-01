import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createUnityAssetsService } from "../../../src/composition/unityAssets.js";
import {
  buildSerializedFile,
  buildUnityWebData,
  unitySceneObjects,
} from "../../fixtures/unity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const write = async (name: string, bytes: Buffer): Promise<string> => {
  const path = join(await createTestTempDirectory("rea-unity-assets-"), name);
  await writeFile(path, bytes);
  return path;
};

it("returns observed Evidence for a SerializedFile", async () => {
  const path = await write(
    "level0",
    buildSerializedFile({ objects: unitySceneObjects() }),
  );
  const service = createUnityAssetsService();
  try {
    const result = await service.inspect({ path });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      operation: "inspect_unity_assets",
      confidence: "observed",
      subject: { format: "file", local_path: path },
      normalized_result: {
        artifact: { path },
        root_game_objects: [{ name: "Hangar" }],
        coverage: { status: "complete" },
      },
    });
  } finally {
    await service.close();
  }
});

it("directs a WebGL data container to extract_artifact", async () => {
  const path = await write(
    "Build.data.gz",
    buildUnityWebData([{ path: "data.unity3d", bytes: Buffer.alloc(8) }]),
  );
  const service = createUnityAssetsService();
  try {
    const result = await service.inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("extract_artifact");
  } finally {
    await service.close();
  }
});

it("rejects a relative path before reading", async () => {
  const service = createUnityAssetsService();
  try {
    const result = await service.inspect({ path: "level0" });
    expect(result.ok).toBe(false);
  } finally {
    await service.close();
  }
});
