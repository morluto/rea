import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { DEB_PACKAGE_TOOL_CONTRACTS } from "../../../src/contracts/deb/debPackageToolContracts.js";
import { debPackageSchema } from "../../../src/domain/deb/debPackage.js";
import {
  debPackageFixture,
  notArBytes,
} from "../../../src/deb/DebPackage.fixture.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const debContract = DEB_PACKAGE_TOOL_CONTRACTS.find(
  (item) => item.name === "inspect_deb_package",
);
if (debContract === undefined)
  throw new Error("Missing inspect_deb_package contract");
const completeDebEvidenceSchema = debContract.outputSchema.safeExtend({
  normalized_result: debPackageSchema,
});

const schemaValidation = createMcpSchemaValidation();
afterAll(() => schemaValidation.clear());

const connect = () =>
  createApplicationMcpHarness({
    session: createTestBinarySession(() => {
      throw new Error(
        "Debian package inspection must not start a deep provider",
      );
    }),
    serverOptions: {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: process.env.REA_MCP_MAX_INPUT_ELEMENTS,
      },
    },
    schemaValidator: schemaValidation,
  });

it("advertises inspect_deb_package and reads package identity", async () => {
  const { client, close } = await connect();
  try {
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === "inspect_deb_package",
    );
    expect(advertised?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
    if (advertised === undefined)
      throw new Error("Missing advertised inspect_deb_package tool");
    expect(advertised.outputSchema).toBeUndefined();
    expect(
      schemaValidation.assertions.validateSchema(
        canonicalOutputSchema(advertised.name),
      ),
    ).toBe(true);
    const root = await createTestTempDirectory("rea-deb-mcp-");
    const path = join(root, "hello_2.03-1_all.deb");
    await writeFile(path, debPackageFixture());
    const response = await client.callTool(
      { name: "inspect_deb_package", arguments: { path } },
      { toolDefinition: advertised },
    );
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = completeDebEvidenceSchema.parse(
      response.structuredContent,
    );
    expect(evidence.normalized_result.control?.package).toBe("hello");
    expect(evidence.normalized_result.control?.version).toMatchObject({
      epoch: 1,
      upstream: "2.03",
      revision: "1",
    });
    expect(evidence.normalized_result.ar.format_version).toBe("2.0");
  } finally {
    await close();
  }
});

it("requires an absolute path for inspect_deb_package", async () => {
  const { client, close } = await connect();
  try {
    const response = await client.callTool({
      name: "inspect_deb_package",
      arguments: { path: "hello.deb" },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_deb_package" },
    });
  } finally {
    await close();
  }
});

it("delivers the parsed control facts when data.tar is refused", async () => {
  const { client, close } = await connect();
  try {
    const root = await createTestTempDirectory("rea-deb-mcp-partial-");
    const path = join(root, "bad-data.deb");
    const bytes = debPackageFixture({ corruptDataChecksum: true });
    await writeFile(path, bytes);
    // The data member's header follows the even-padded control member; its
    // offset depends on the compressed control size, so derive it.
    const dataHeader = bytes.indexOf("data.tar.gz", 8, "latin1");
    const dataOffset = dataHeader + 60;
    const response = await client.callTool({
      name: "inspect_deb_package",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    const { error } = parseMcpToolError(response);
    expect(error).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_deb_package",
        failure_kind: "malformed",
        format: "deb",
        diagnostics: {
          partial: {
            ar: {
              members: expect.arrayContaining([
                expect.objectContaining({
                  name: "data.tar.gz",
                  offset: dataOffset,
                }),
              ]),
            },
            control: {
              package: "hello",
              version: { raw: "1:2.03-1" },
              maintainer_scripts: expect.arrayContaining([
                expect.objectContaining({ name: "postinst" }),
              ]),
            },
          },
        },
      },
    });
  } finally {
    await close();
  }
});

it("refuses malformed ar bytes and inspects xz-compressed members", async () => {
  const { client, close } = await connect();
  try {
    const root = await createTestTempDirectory("rea-deb-mcp-refuse-");
    const malformed = join(root, "not.deb");
    const xz = join(root, "hello.xz.deb");
    await writeFile(malformed, notArBytes());
    await writeFile(
      xz,
      debPackageFixture({
        controlCompression: "xz",
        dataCompression: "xz",
      }),
    );
    const invalid = await client.callTool({
      name: "inspect_deb_package",
      arguments: { path: malformed },
    });
    expect(parseMcpToolError(invalid).error).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_deb_package",
        failure_kind: "malformed",
        format: "deb",
      },
    });
    const inspected = await client.callTool({
      name: "inspect_deb_package",
      arguments: { path: xz },
    });
    expect(inspected.isError, JSON.stringify(inspected.content)).not.toBe(true);
    const evidence = completeDebEvidenceSchema.parse(
      inspected.structuredContent,
    );
    expect(evidence.normalized_result.control?.package).toBe("hello");
    expect(
      evidence.normalized_result.ar.members.map((member) => member.name),
    ).toEqual(["debian-binary", "control.tar.xz", "data.tar.xz"]);
  } finally {
    await close();
  }
});
