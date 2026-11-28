import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { INSPECT_EVM_PROXY_CONTRACT } from "../../../src/contracts/evm/evmProxyToolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const ADDRESS = "be".repeat(20);

cliTest(
  "reports the same clone facts through CLI and stdio MCP",
  async ({ cli }) => {
    const path = join(
      await createTestTempDirectory("rea-evm-proxy-cli-"),
      "runtime.bin",
    );
    await writeFile(
      path,
      Buffer.from(
        `363d3d373d3d3d363d73${ADDRESS}5af43d82803e903d91602b57fd5bf3`,
        "hex",
      ),
    );
    const result = await cli.run({
      arguments: ["inspect-evm-proxy", path, "raw", "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    const response = await call("inspect_evm_proxy", {
      path,
      encoding: "raw",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    for (const value of [result.json, response.structuredContent])
      expect(
        INSPECT_EVM_PROXY_CONTRACT.outputSchema.parse(value).normalized_result
          .pattern,
      ).toEqual({
        kind: "erc1167",
        implementation: `0x${ADDRESS}`,
        implementation_byte_range: { start: 10, end: 30 },
      });
  },
);
