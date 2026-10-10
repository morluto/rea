import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { toolContract } from "../../../dist/contracts/toolContracts.js";
import {
  artifactCliEvidence,
  withArtifactMcp,
} from "../../lib/artifact-e2e.mjs";

/** Inspect the compiled bundle with real native utilities through both adapters. */
export async function verifyNativeProvenance(app, executable) {
  const original = await readFile(executable);
  const sha256 = createHash("sha256").update(original).digest("hex");
  const symbols = ["$s4main3FooV", "plain_symbol"];
  const operations = [
    ["inspect_macho", []],
    ["inspect_signature", []],
    ["inspect_plist", []],
    ["list_architectures", []],
    ["demangle_swift", symbols],
  ];
  const observations = [];
  await withArtifactMcp(app, async (client) => {
    const definitions = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    for (const [operation, arguments_] of operations) {
      const cli = toolContract(operation).outputSchema.parse(
        await artifactCliEvidence(
          operation.replaceAll("_", "-"),
          app,
          arguments_,
        ),
      );
      const response = await client.callTool(
        {
          name: operation,
          arguments: operation === "demangle_swift" ? { symbols } : {},
        },
        { toolDefinition: definitions.get(operation) },
      );
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const mcp = toolContract(operation).outputSchema.parse(
        response.structuredContent,
      );
      assert.equal(cli.raw_result, null);
      assert.equal(mcp.raw_result, null);
      assert.ok(cli.normalized_result.provenance.length > 0);
      assert.deepEqual(mcp.normalized_result, cli.normalized_result);
      assert.deepEqual(
        JSON.parse(response.content.find((item) => item.type === "text").text),
        response.structuredContent,
      );
      await client.ping();
      observations.push({
        operation,
        commands: cli.normalized_result.provenance.length,
        cli_bytes: Buffer.byteLength(JSON.stringify(cli)),
        mcp_bytes: Buffer.byteLength(JSON.stringify(response)),
      });
    }
  });
  assert.deepEqual(await readFile(executable), original);
  return {
    real_native_utilities: true,
    target_sha256: sha256,
    bytes_unchanged: true,
    observations,
  };
}
