import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createIl2cppMetadataFixture } from "../fixtures/il2cpp/metadata.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "reports inconsistent IL2CPP table extents through CLI and MCP without a binary",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-extent-");
    const { call } = await connectLocalToolsMcp();
    for (const [version, name] of [
      [31, "genericContainers"],
      [31, "genericParameters"],
      [31, "interfaceOffsets"],
      [39, "genericContainers"],
      [39, "genericParameters"],
      [39, "parameters"],
    ] as const) {
      const isCountedContainer = version === 39 && name === "genericContainers";
      const fixture = createIl2cppMetadataFixture({
        version,
        genericOwners: true,
        ...(isCountedContainer && { interfaceOffsets: false }),
      });
      const path = join(root, `${version}-${name}.dat`);
      await writeFile(path, fixture.bytes);
      const intact = await cli.run({
        arguments: ["inspect-il2cpp-metadata", path, "--json"],
      });
      expect(intact.exitCode, intact.stderr).toBe(0);

      const damaged = Buffer.from(fixture.bytes);
      if (isCountedContainer || name === "parameters") {
        damaged.writeInt32LE(300, fixture.header(name, "count"));
      } else {
        damaged.writeInt32LE(
          fixture.section(name).size - 1,
          fixture.header(name, "size"),
        );
      }
      await writeFile(path, damaged);
      const invalid = await cli.run({
        arguments: ["inspect-il2cpp-metadata", path, "--json"],
      });
      const expected = {
        code: "unsupported_target",
        details: {
          path,
          failure_kind: "malformed",
          format: "il2cpp-metadata",
          reason: expect.stringContaining(
            `record-size-mismatch: section ${name}`,
          ),
        },
      };
      expect(invalid.exitCode).toBe(1);
      expect(invalid.json).toMatchObject(expected);
      const result = await call("inspect_il2cpp_metadata", { path });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result).error).toMatchObject(expected);
    }
  },
);
