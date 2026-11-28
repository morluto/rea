import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { YARA_TOOL_CONTRACTS } from "../../../src/contracts/yara/yaraToolContracts.js";
import { yaraMatchesSchema } from "../../../src/domain/yara/yaraMatches.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  writeYaraStub,
  YARA_STUB_RULE,
  YARA_STUB_SAMPLE,
  yaraStubService,
} from "../../fixtures/yara/yaraStub.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const yaraContract = contractNamed(YARA_TOOL_CONTRACTS, "inspect_yara_matches");
const completeYaraEvidenceSchema = yaraContract.outputSchema.safeExtend({
  normalized_result: yaraMatchesSchema,
});
const posixTest = mcpTest.skipIf(process.platform === "win32");

const connect = async (mcp: TestMcp, mode: string) => {
  const root = await createTestTempDirectory("rea-yara-mcp-");
  const command = await writeYaraStub(root);
  const sample = join(root, "sample.bin");
  await writeFile(sample, YARA_STUB_SAMPLE);
  const rule = join(root, "packers.yar");
  await writeFile(rule, YARA_STUB_RULE);
  const session = createTestBinarySession(() => {
    throw new Error("YARA scanning must not start a deep provider");
  });
  const client = await mcp.connect(
    createServer(
      { kind: "session", session },
      {
        yaraMatches: yaraStubService(command, {
          ...process.env,
          YARA_STUB_MODE: mode,
        }),
      },
    ),
  );
  return { client, session, sample, rule };
};

posixTest(
  "advertises inspect_yara_matches and returns matches as Evidence",
  async ({ mcp }) => {
    const { client, session, sample, rule } = await connect(mcp, "match");
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_yara_matches",
      );
      expect(yaraContract.effects.writesFilesystem).toBe(true);
      expect(advertised?.annotations).toMatchObject({ readOnlyHint: false });
      const response = await client.callTool({
        name: "inspect_yara_matches",
        arguments: { path: sample, rule_paths: [rule] },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = completeYaraEvidenceSchema.parse(
        response.structuredContent,
      );
      expect(
        evidence.normalized_result.matches.map(({ rule }) => rule),
      ).toEqual(["Packed", "Plain"]);
      expect(evidence.normalized_result.rule_files[0]?.path).toBe(rule);
    } finally {
      await session.close();
    }
  },
);

posixTest(
  "reports a rule compile error as invalid input naming the rule file",
  async ({ mcp }) => {
    const { client, session, sample, rule } = await connect(mcp, "compile");
    try {
      const response = await client.callTool({
        name: "inspect_yara_matches",
        arguments: { path: sample, rule_paths: [rule] },
      });
      const { error } = parseMcpToolError(response);
      expect(error.code).toBe("invalid_request");
      expect(JSON.stringify(error)).toContain("undefined identifier");
      expect(error.remediation.action).toContain(
        "import the module that provides it",
      );
    } finally {
      await session.close();
    }
  },
);

posixTest(
  "refuses a rule file with an include directive before yara starts",
  async ({ mcp }) => {
    const { client, session, sample, rule } = await connect(mcp, "match");
    const including = join(rule, "..", "including.yar");
    await writeFile(
      including,
      '// include "comment.yar"\ninclude "packers.yar"\nrule Main { condition: true }\n',
    );
    try {
      const response = await client.callTool({
        name: "inspect_yara_matches",
        arguments: { path: sample, rule_paths: [rule, including] },
      });
      const { error } = parseMcpToolError(response);
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain(
        `${including}(2:1): include "packers.yar"`,
      );
      expect(error.message).not.toContain("comment.yar");
      expect(error.remediation.action).toContain(
        "pass the included file as another rule_paths entry",
      );
      expect(error.details).toMatchObject({
        diagnostics: {
          include_directives: [
            {
              rule_path_index: 1,
              total: 1,
              listed: [{ line: 2, column: 1, path: "packers.yar" }],
            },
          ],
        },
      });
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports yara unavailable without affecting other tools",
  async ({ mcp }) => {
    const root = await createTestTempDirectory("rea-yara-mcp-missing-");
    const sample = join(root, "sample.bin");
    await writeFile(sample, YARA_STUB_SAMPLE);
    const rule = join(root, "packers.yar");
    await writeFile(rule, YARA_STUB_RULE);
    const session = createTestBinarySession(() => {
      throw new Error("YARA scanning must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer(
        { kind: "session", session },
        {
          environment: {
            ...process.env,
            REA_YARA_COMMAND: join(root, "missing-yara"),
          },
        },
      ),
    );
    try {
      const response = await client.callTool({
        name: "inspect_yara_matches",
        arguments: { path: sample, rule_paths: [rule] },
      });
      const { error } = parseMcpToolError(response);
      expect(error.code).toBe("capability_unavailable");
      expect(error.remediation.action).toContain("REA_YARA_COMMAND");
      const entropy = await client.callTool({
        name: "inspect_byte_entropy",
        arguments: { path: sample },
      });
      expect(entropy.isError, JSON.stringify(entropy.content)).not.toBe(true);
    } finally {
      await session.close();
    }
  },
);
