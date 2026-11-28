import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { VERIFY_SOLIDITY_METADATA_CONTRACT } from "../../../src/contracts/evm/solidityMetadataToolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// A deliberately different commitment, so the supplied file mismatches.
const HASH = `1220${"ab".repeat(32)}`;

cliTest(
  "reports the same metadata verdict through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-solidity-metadata-cli-");
    const path = join(root, "runtime.bin");
    const metadata_path = join(root, "metadata.json");
    await writeFile(path, Buffer.from(`00a164697066735822${HASH}002a`, "hex"));
    await writeFile(metadata_path, "hello world\n");
    const result = await cli.run({
      arguments: [
        "verify-solidity-metadata",
        path,
        "raw",
        metadata_path,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    const response = await call("verify_solidity_metadata", {
      path,
      encoding: "raw",
      metadata_path,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    for (const value of [result.json, response.structuredContent]) {
      const evidence =
        VERIFY_SOLIDITY_METADATA_CONTRACT.outputSchema.parse(value);
      expect(evidence.parameters).not.toHaveProperty("max_metadata_bytes");
      expect(evidence.normalized_result.binding).toMatchObject({
        status: "mismatch",
        recorded: HASH,
      });
    }
  },
);
