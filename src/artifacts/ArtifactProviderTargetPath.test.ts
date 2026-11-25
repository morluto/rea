import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { zipArchive } from "../domain/desktop/zipArchive.fixture.js";

import { ArtifactProvider } from "./ArtifactProvider.js";
import { malformedArtifact } from "../resources/ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import * as interfaceBuilder from "./apple/InterfaceBuilderAnalysis.js";

it("names the bundle the caller selected, not its resolved target, in a target failure", async () => {
  const inspect = vi
    .spyOn(interfaceBuilder, "analyzeInterfaceBuilderBundle")
    .mockRejectedValue(malformedArtifact("nib-archive", "controlled refusal"));
  const client = new ArtifactProvider({}, "darwin").createBundleResourceClient({
    callerPath: "/fixture/Selected.app",
    canonicalPath: "/fixture/Actual.app",
    infoPlistPath: "/fixture/Actual.app/Info.plist",
    layout: "root",
    executableSha256: null,
  });
  try {
    const result = await client.execute("decode_interface_builder", {});
    if (result.ok) throw new Error("Expected a target failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "decode_interface_builder",
        path: "/fixture/Selected.app",
        failure_kind: "malformed",
        format: "nib-archive",
      },
    });
  } finally {
    inspect.mockRestore();
    await client.close();
  }
});

it("names the spelling the caller selected for an opened target, not the resolved file", async () => {
  const root = await createTestTempDirectory("rea-target-alias-");
  const path = join(root, "actual.zip");
  const bytes = zipArchive([{ name: "member.bin", data: "member bytes" }]);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(bytes.length + 1024, central + 42);
  await writeFile(path, bytes);
  const client = new ArtifactProvider({}, "darwin").createClient({
    path,
    sourcePath: path,
    callerInputPath: join(root, "selected.zip"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "archive",
    format: "zip",
  });
  try {
    const result = await client.execute("inventory_artifact", {});
    if (result.ok) throw new Error("Expected a target failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      details: { path: join(root, "selected.zip"), failure_kind: "malformed" },
    });
  } finally {
    await client.close();
  }
});
