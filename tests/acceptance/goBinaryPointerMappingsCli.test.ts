import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { evidenceResultOf } from "../../src/contracts/toolOutputSchemaPrimitives.js";
import { goBinarySchema } from "../../src/domain/go/goBinary.js";
import { createGoCrossLoadPointerFixture } from "../fixtures/go/image.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { expectCliMcpEvidenceParity } from "../fixtures/cliMcpEvidenceParity.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "retains cross-load ELF pointer metadata and rejects a one-byte gap through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-go-pointer-mappings-");
    const { client, call } = await connectLocalToolsMcp();
    const fixture = createGoCrossLoadPointerFixture("contents");
    const validPath = join(root, "elf-cross-load-contents");
    await writeFile(validPath, fixture.bytes);
    const result = await cli.run({
      arguments: ["inspect-go-binary", validPath, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = evidenceResultOf(goBinarySchema).parse(result.json);
    expect(evidence.normalized_result.build_info).toMatchObject({
      encoding: "pointer",
      go_version: "go1.26.0",
      go_version_bytes_base64: Buffer.from("go1.26.0").toString("base64"),
      module_bytes_base64: fixture.moduleBytes.toString("base64"),
      module: { path: "example.com/tool/cmd/tool" },
      version_location: { offset: fixture.versionOffset, bytes: 8 },
      module_location: {
        offset: fixture.moduleOffset,
        bytes: fixture.moduleBytes.length,
      },
    });
    expect(fileIdentity(evidence.subject).sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    const accepted = await call("inspect_go_binary", { path: validPath });
    expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
    expectCliMcpEvidenceParity(evidence, accepted.structuredContent, validPath);
    expect(Buffer.compare(await readFile(validPath), fixture.bytes)).toBe(0);

    const damaged = createGoCrossLoadPointerFixture("contents");
    // Keep both load translations and leave the final byte of the first load unmapped.
    damaged.bytes.writeBigUInt64LE(4095n, 160);
    damaged.bytes.writeBigUInt64LE(4095n, 168);
    const path = join(root, "elf-cross-load-gap");
    await writeFile(path, damaged.bytes);
    const rejected = await cli.run({
      arguments: ["inspect-go-binary", path, "--json"],
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json).toMatchObject({
      code: "unsupported_target",
      details: {
        format_failure: expect.stringMatching(/^(?:malformed|truncated)$/u),
      },
    });
    const response = await call("inspect_go_binary", { path });
    expect(parseMcpToolError(response)).toEqual({ error: rejected.json });
    await client.ping();
  },
);
