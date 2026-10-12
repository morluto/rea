import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";

const sliceReader = vi.hoisted(() => ({
  reached: vi.fn(),
  failure: null as unknown,
}));

vi.mock("../../../../src/artifacts/MachOSliceArtifactReader.js", () => ({
  MachOSliceArtifactReader: class {
    async *entries() {
      sliceReader.reached();
      yield* [];
      throw sliceReader.failure;
    }

    close() {
      return Promise.resolve();
    }

    provenance() {
      return [];
    }
  },
}));

it("routes universal Mach-O extraction through slice inventory", async () => {
  sliceReader.reached.mockClear();
  sliceReader.failure = new ArtifactReaderFailure(
    "unavailable",
    "fixture reached universal slice inventory",
  );
  const root = await createTestTempDirectory("rea-extract-universal-");
  const image = join(root, "Universal");
  await writeFile(image, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0]));
  const output = join(root, "output");
  const result = await new ArtifactProvider(process.env)
    .createClient(universalTarget(image))
    .execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({ output_root: output }),
    );

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ArtifactOperationError",
      reason: "unavailable",
      detail: "fixture reached universal slice inventory",
    },
  });
  expect(sliceReader.reached).toHaveBeenCalledOnce();
  await expect(access(output)).rejects.toThrow();
});

const universalTarget = (path: string): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: "executable",
  format: "mach-o-universal",
  architecture: "arm64",
  availableArchitectures: ["arm64"],
});
