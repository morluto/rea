import { fileIdentity } from "../fixtures/evidenceSubject.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { evidenceResultOf } from "../../src/contracts/toolOutputSchemaPrimitives.js";
import { goBinarySchema } from "../../src/domain/go/goBinary.js";
import {
  createGoCrossLoadPointerFixture,
  createGoPeHeaderPointerFixture,
} from "../fixtures/go/image.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { expectCliMcpEvidenceParity } from "../fixtures/cliMcpEvidenceParity.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "retains header-backed PE and cross-load ELF pointer metadata through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-go-pointer-mappings-");
    const { client, call } = await connectLocalToolsMcp();
    const cases = [
      {
        name: "pe32-header-descriptors",
        fixture: createGoPeHeaderPointerFixture(32, "descriptors"),
      },
      {
        name: "elf-cross-load-contents",
        fixture: createGoCrossLoadPointerFixture("contents"),
      },
    ];
    for (const { name, fixture } of cases) {
      const path = join(root, name);
      await writeFile(path, fixture.bytes);
      const result = await cli.run({
        arguments: ["inspect-go-binary", path, "--json"],
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
      const response = await call("inspect_go_binary", { path });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expectCliMcpEvidenceParity(evidence, response.structuredContent, path);
      expect(Buffer.compare(await readFile(path), fixture.bytes)).toBe(0);
    }

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
      code: "invalid_request",
      details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
    });
    const response = await call("inspect_go_binary", { path });
    expect(parseMcpToolError(response)).toEqual({ error: rejected.json });
    await client.ping();
  },
);
