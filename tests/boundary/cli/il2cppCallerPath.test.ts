import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { readEvidenceBundle } from "../../../src/application/EvidenceBundleFiles.js";
import { createLinkedIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";
import { createIl2cppDyldBindFixture } from "../../fixtures/il2cpp/binary.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves both selected IL2CPP input spellings in inline and bundled Evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-selected-paths-");
    await writeFile(
      join(root, "metadata.dat"),
      createLinkedIl2cppMetadataFixture().bytes,
    );
    await writeFile(
      join(root, "GameAssembly.dylib"),
      createIl2cppDyldBindFixture(0n),
    );
    const input = "./metadata.dat";
    const binary = "./GameAssembly.dylib";
    const inline = await cli.run({
      cwd: root,
      arguments: [
        "inspect-il2cpp-metadata",
        input,
        "--binary",
        binary,
        "--json",
      ],
    });
    expect(inline.exitCode, inline.stderr).toBe(0);
    const evidence = parseEvidence(inline.json);
    expect(evidence.caller_input_path).toBe(input);
    expect(evidence.caller_input_paths).toEqual({ binary_path: binary });
    const summaryArgs = [
      "inspect-il2cpp-metadata",
      input,
      "--binary",
      binary,
      "--detail",
      "summary",
      "--evidence_output",
      "./evidence.json",
      "--json",
    ];
    const summary = await cli.run({
      cwd: root,
      arguments: summaryArgs,
    });
    expect(summary.exitCode, summary.stderr).toBe(0);
    expect(
      parseEvidence((summary.json as { summary: unknown }).summary)
        .caller_input_paths,
    ).toEqual({ binary_path: binary });
    const refused = await cli.run({
      cwd: root,
      arguments: summaryArgs,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      details: {
        partial_observation: { caller_input_paths: { binary_path: binary } },
      },
    });
    const saved = await readEvidenceBundle(join(root, "evidence.json"));
    if (!saved.ok) throw saved.error;
    expect(saved.value.records[0]?.caller_input_paths).toEqual({
      binary_path: binary,
    });
    const without = await cli.run({
      cwd: root,
      arguments: ["inspect-il2cpp-metadata", input, "--json"],
    });
    expect(without.exitCode, without.stderr).toBe(0);
    expect(parseEvidence(without.json).caller_input_paths).toBeUndefined();
  },
);
