import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { expect } from "vitest";

import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { YARA_TOOL_CONTRACTS } from "../../src/contracts/yara/yaraToolContracts.js";
import { analysisErrorProjectionSchema } from "../../src/domain/analysisErrorProjectionSchema.js";
import { yaraMatchesSchema } from "../../src/domain/yara/yaraMatches.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  writeYaraStub,
  YARA_STUB_RULE,
  YARA_STUB_SAMPLE,
} from "../fixtures/yara/yaraStub.js";
import { cliTest } from "../support/cli/cliFixture.js";

const completeYaraEvidenceSchema = contractNamed(
  YARA_TOOL_CONTRACTS,
  "inspect_yara_matches",
).outputSchema.safeExtend({ normalized_result: yaraMatchesSchema });
const posixCliTest = cliTest.skipIf(process.platform === "win32");

const workspace = async () => {
  const root = await createTestTempDirectory("rea-yara-cli-");
  const command = await writeYaraStub(root);
  await writeFile(join(root, "sample.bin"), YARA_STUB_SAMPLE);
  await writeFile(join(root, "packers.yar"), YARA_STUB_RULE);
  return { root, command };
};

posixCliTest(
  "scans a relative file with relative rule paths through inspect-yara-matches",
  async ({ cli }) => {
    const { root, command } = await workspace();
    const output = await cli.run({
      arguments: [
        "inspect-yara-matches",
        "./sample.bin",
        "--rule_paths",
        "./packers.yar",
        "--format",
        "json",
      ],
      cwd: root,
      environment: { REA_YARA_COMMAND: command, YARA_STUB_MODE: "match" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const evidence = completeYaraEvidenceSchema.parse(output.json);
    // Relative caller paths reach yara as absolute paths.
    expect(isAbsolute(evidence.normalized_result.artifact.path)).toBe(true);
    expect(evidence.normalized_result.artifact.path).toMatch(/sample\.bin$/u);
    expect(evidence.normalized_result.rule_files).toEqual([
      expect.objectContaining({
        path: expect.stringMatching(/packers\.yar$/u),
      }),
    ]);
    expect(evidence.normalized_result.matches.map(({ rule }) => rule)).toEqual([
      "Packed",
      "Plain",
    ]);
  },
);

posixCliTest(
  "exits with a rule compile error naming the rule file",
  async ({ cli }) => {
    const { root, command } = await workspace();
    const output = await cli.run({
      arguments: [
        "inspect-yara-matches",
        "./sample.bin",
        "--rule_paths",
        "./packers.yar",
        "--format",
        "json",
      ],
      cwd: root,
      environment: { REA_YARA_COMMAND: command, YARA_STUB_MODE: "compile" },
    });
    expect(output.exitCode).toBe(1);
    const error = analysisErrorProjectionSchema.parse(output.json);
    expect(error.code).toBe("invalid_request");
    expect(JSON.stringify(error)).toContain("packers.yar(3)");
  },
);

posixCliTest(
  "refuses a rule file with an include directive before yara starts",
  async ({ cli }) => {
    const { root, command } = await workspace();
    await writeFile(
      join(root, "including.yar"),
      'rule Main { strings: $s = "include \\"no.yar\\"" condition: $s }\ninclude "packers.yar"\n',
    );
    const output = await cli.run({
      arguments: [
        "inspect-yara-matches",
        "./sample.bin",
        "--rule_paths",
        "./including.yar",
        "--format",
        "json",
      ],
      cwd: root,
      environment: { REA_YARA_COMMAND: command, YARA_STUB_MODE: "match" },
    });
    expect(output.exitCode).toBe(1);
    const error = analysisErrorProjectionSchema.parse(output.json);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(
      /including\.yar\(2:1\): include "packers\.yar"/u,
    );
    expect(error.message).not.toContain("no.yar");
  },
);

posixCliTest(
  "reports the scanned snapshot when a rule fails its final identity check",
  async ({ cli }) => {
    const { root, command } = await workspace();
    const sample = join(root, "sample.bin");
    const rule = join(root, "packers.yar");
    const output = await cli.run({
      arguments: [
        "inspect-yara-matches",
        sample,
        "--rule_paths",
        rule,
        "--format",
        "json",
      ],
      cwd: root,
      environment: { REA_YARA_COMMAND: command, YARA_STUB_MODE: "mutate-rule" },
    });
    expect(output.exitCode, output.stderr).toBe(1);
    expect(analysisErrorProjectionSchema.parse(output.json)).toMatchObject({
      code: "artifact_changed",
      details: {
        path: rule,
        partial_observation: {
          kind: "file-snapshot-hash",
          path: sample,
          sha256: createHash("sha256").update(YARA_STUB_SAMPLE).digest("hex"),
          bytes: YARA_STUB_SAMPLE.length,
        },
      },
    });
  },
);

posixCliTest(
  "resolves a relative REA_YARA_COMMAND against the caller's working directory",
  async ({ cli }) => {
    const { root } = await workspace();
    const output = await cli.run({
      arguments: [
        "inspect-yara-matches",
        "./sample.bin",
        "--rule_paths",
        "./packers.yar",
        "--format",
        "json",
      ],
      cwd: root,
      environment: {
        REA_YARA_COMMAND: "./yara-stub.cjs",
        YARA_STUB_MODE: "match",
      },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const evidence = completeYaraEvidenceSchema.parse(output.json);
    expect(evidence.normalized_result.matches.map(({ rule }) => rule)).toEqual([
      "Packed",
      "Plain",
    ]);
  },
);

cliTest("reports a missing yara command as unavailable", async ({ cli }) => {
  const { root } = await workspace();
  const output = await cli.run({
    arguments: [
      "inspect-yara-matches",
      "./sample.bin",
      "--rule_paths",
      "./packers.yar",
      "--format",
      "json",
    ],
    cwd: root,
    environment: { REA_YARA_COMMAND: join(root, "missing-yara") },
  });
  expect(output.exitCode).not.toBe(0);
  const error = analysisErrorProjectionSchema.parse(output.json);
  expect(error.code).toBe("capability_unavailable");
  expect(error.remediation.action).toContain("REA_YARA_COMMAND");
});
