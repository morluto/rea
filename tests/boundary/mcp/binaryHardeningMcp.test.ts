import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  elfHardeningFixture,
  machoHardeningFixture,
} from "../../../src/native/hardening/BinaryHardening.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "advertises and reads binary hardening without executing or changing the image",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_binary_hardening",
      );
      if (definition === undefined)
        throw new Error("Missing advertised contract");
      expect(definition.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-binary-hardening-mcp-");
      const path = join(root, "app");
      const bytes = elfHardeningFixture({
        pieFlag: true,
        gnuStack: { flags: 7 },
      });
      await writeFile(path, bytes);
      const response = await client.callTool(
        { name: "inspect_binary_hardening", arguments: { path } },
        { toolDefinition: definition },
      );
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract(
        "inspect_binary_hardening",
      ).outputSchema.parse(response.structuredContent);
      const rows = evidence.normalized_result.images[0]?.rows ?? [];
      expect(rows.find((row) => row.property === "pie")).toMatchObject({
        state: "enabled",
        confidence: "derived",
      });
      expect(rows.find((row) => row.property === "nx")?.state).toBe("disabled");
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
      const bad = await client.callTool(
        {
          name: "inspect_binary_hardening",
          arguments: { path: "relative" },
        },
        { toolDefinition: definition },
      );
      expect(bad.isError).toBe(true);
    } finally {
      await session.close();
    }
  },
);

mcpTest(
  "reports an unknown ARM64 subtype without treating its display fallback as arm64e proof",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Must not start a deep provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const root = await createTestTempDirectory("rea-arm64-subtype-");
      const path = join(root, "image");
      for (const [subtype, state] of [
        [0, "disabled"],
        [1, "disabled"],
        [2, "enabled"],
        [0x8000000c, "enabled"],
        [3, "unknown"],
      ] as const) {
        const bytes = machoHardeningFixture({ cpuSubtype: subtype });
        await writeFile(path, bytes);
        const response = await client.callTool({
          name: "inspect_binary_hardening",
          arguments: { path },
        });
        expect(response.isError, JSON.stringify(response.content)).not.toBe(
          true,
        );
        const evidence = toolContract(
          "inspect_binary_hardening",
        ).outputSchema.parse(response.structuredContent);
        const image = evidence.normalized_result.images[0];
        expect(image?.status).toBe("parsed");
        expect(
          image?.rows.find((row) => row.property === "arm64e")?.state,
        ).toBe(state);
      }
    } finally {
      await session.close();
    }
  },
);
