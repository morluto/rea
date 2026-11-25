import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BROWSER_EXTENSION_TOOL_CONTRACTS } from "../../src/contracts/browserExtension/browserExtensionToolContracts.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { browserExtensionSchema } from "../../src/domain/browserExtension/browserExtension.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = contractNamed(
  BROWSER_EXTENSION_TOOL_CONTRACTS,
  "inspect_browser_extension",
);
const completeEvidenceSchema = contract.outputSchema.safeExtend({
  normalized_result: browserExtensionSchema,
});

cliTest(
  "reads an unpacked manifest.json through CLI and MCP with the same declared surface",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-browser-extension-cli-");
    const path = join(root, "manifest.json");
    const bytes = Buffer.from(
      JSON.stringify({
        manifest_version: 3,
        name: "__MSG_extName__",
        version: "1.0.0",
        permissions: ["storage", "tabs"],
        host_permissions: ["https://example.com/*"],
        content_scripts: [
          { matches: ["https://example.com/*"], js: ["content.js"] },
        ],
        background: { service_worker: "background.js" },
      }),
    );
    await writeFile(path, bytes);
    const output = await cli.run({
      arguments: ["inspect-browser-extension", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const cliEvidence = completeEvidenceSchema.parse(output.json);
    expect(cliEvidence).toMatchObject({
      confidence: "observed",
      operation: "inspect_browser_extension",
      subject: { local_path: path, identity: { format: "file" } },
      normalized_result: {
        format: "unpacked",
        container: null,
        artifact: {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        manifest: {
          permissions: ["storage", "tabs"],
          host_permissions: ["https://example.com/*"],
          message_keys: ["extName"],
        },
      },
    });
    const { call } = await connectLocalToolsMcp();
    const response = await call("inspect_browser_extension", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = completeEvidenceSchema.parse(response.structuredContent);
    expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
  },
);
