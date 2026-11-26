import {
  canonicalOutputSchema,
  withCanonicalOutputSchema,
} from "../../fixtures/canonicalOutputSchema.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  elfHardeningFixture,
  machoHardeningFixture,
  peHardeningImage,
} from "../../../src/native/hardening/BinaryHardening.fixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "validates Windows and POSIX hardening result paths against the canonical MCP schema",
  async ({ mcp }) => {
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(canonicalOutputSchema("inspect_binary_hardening") as AnySchema);
    const session = createTestBinarySession(() => {
      throw new Error("Hardening inspection must not acquire a provider");
    });
    const client = await mcp.connect(
      createServer({ kind: "session", session }),
    );
    try {
      const root = await createTestTempDirectory(
        "rea-portable-hardening-schema-",
      );
      const path = join(root, "app.exe");
      const bytes = peHardeningImage();
      await writeFile(path, bytes);
      const response = await client.callTool({
        name: "inspect_binary_hardening",
        arguments: { path },
      });
      expect(response.isError).not.toBe(true);
      const evidence = toolContract(
        "inspect_binary_hardening",
      ).outputSchema.parse(response.structuredContent);
      expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
      // The producer ran on this host. Only the path is substituted to test the
      // shipped contract independently; this is not a Windows filesystem run.
      for (const foreignPath of [
        "C:\\Windows\\System32\\cmd.exe",
        "c:/tools/app.exe",
        "\\\\server\\share\\app.exe",
        "/opt/tools/app",
      ]) {
        const projected = structuredClone(evidence);
        projected.normalized_result.artifact.path = foreignPath;
        expect(
          validate(projected),
          `${foreignPath}: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
      }
      for (const invalid of ["", "relative/app.exe", "C:app.exe", "/tmp/\0"]) {
        const projected = structuredClone(evidence);
        projected.normalized_result.artifact.path = invalid;
        expect(validate(projected), invalid).toBe(false);
      }
      expect((await readFile(path)).equals(bytes)).toBe(true);
    } finally {
      await session.close();
    }
  },
);

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
        { toolDefinition: withCanonicalOutputSchema(definition) },
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
        { toolDefinition: withCanonicalOutputSchema(definition) },
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
