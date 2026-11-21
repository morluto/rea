import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { sha256Hex } from "../../src/kernel/sha256Hex.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { registryFixture } from "../fixtures/rasterRegistry.js";
import { cliTest } from "../support/cli/cliFixture.js";
const inspect = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_structured_raster_candidates",
);
const export_ = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "export_structured_raster_resources",
);
cliTest(
  "inspects family colors and exports full resources through public CLI controls",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-export-cli-");
    const path = join(root, "source"),
      output = join(root, "export"),
      fixture = registryFixture();
    await writeFile(path, fixture.bytes);
    const color = JSON.stringify({
      kind: "record12-lut-registry",
      theme_slot: 0,
      precision: "byte8",
      alpha: "opaque",
      sentinel: "disabled",
      rgb565_color_key: null,
    });
    const shared = [
      path,
      "--resource-family",
      "record12-lut-registry",
      "--color-policy",
      color,
    ];
    const observation = await cli.run({
      arguments: [
        "inspect-structured-raster-candidates",
        ...shared,
        "--max-previews",
        "1",
        "--json",
      ],
    });
    expect(observation.exitCode, observation.stdout + observation.stderr).toBe(
      0,
    );
    const before = inspect.outputSchema.parse(observation.json);
    expect(before.normalized_result.resourceFamily?.status).toBe("unique");
    expect(
      before.normalized_result.tables[0]?.resources[0]?.preview?.kind,
    ).toBe("profile-declared");
    const result = await cli.run({
      arguments: [
        "export-structured-raster-resources",
        ...shared,
        "--expected-sha256",
        before.normalized_result.artifact.sha256,
        "--output-directory",
        output,
        "--json",
      ],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const evidence = export_.outputSchema.parse(result.json);
    expect(evidence.parameters).not.toHaveProperty("formats");
    expect(evidence.normalized_result.exported).toBe(fixture.count);
    const manifest = await readFile(join(output, "manifest.json"));
    expect(sha256Hex(manifest)).toBe(
      evidence.normalized_result.manifest.sha256,
    );
    expect((await readFile(path)).equals(Buffer.from(fixture.bytes))).toBe(
      true,
    );
  },
);
