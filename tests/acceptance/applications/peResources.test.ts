import { fileIdentity } from "../../fixtures/evidenceSubject.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { peResourcesSchema } from "../../../src/domain/native/peResources.js";
import { peResourceFixture } from "../../../src/domain/pe/peResources.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

type PeResourceCall = (
  arguments_: Record<string, unknown>,
) => ReturnType<Client["callTool"]>;

const expectPeInputFailureAcrossAdapters = async (input: {
  readonly cli: TestCli;
  readonly call: PeResourceCall;
  readonly path: string;
  readonly reason: "invalid_format" | "invalid_value";
}) => {
  const { cli, call, path, reason } = input;
  const result = await cli.run({
    arguments: ["inspect-pe-resources", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  // A missing file is a request-field error; malformed bytes are a target
  // refusal.
  expect(result.json).toMatchObject(
    reason === "invalid_value"
      ? {
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation: "inspect_pe_resources",
            issues: [{ path: ["path"], reason }],
          },
        }
      : {
          code: "unsupported_target",
          category: "unsupported_target",
          details: {
            operation: "inspect_pe_resources",
            path,
            failure_kind: expect.stringMatching(/^(?:malformed|truncated)$/u),
          },
        },
  );
  const response = await call({ path });
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toBeUndefined();
  expect(parseMcpToolError(response)).toEqual({ error: result.json });
};

const expectPeInputFailuresAcrossAdapters = async (input: {
  readonly cli: TestCli;
  readonly call: PeResourceCall;
  readonly root: string;
}) => {
  const { cli, call, root } = input;
  const malformedPath = join(root, "malformed.exe");
  await writeFile(malformedPath, Buffer.from("not a PE image"));
  const truncatedPath = join(root, "truncated-resource-table.exe");
  const truncated = peResourceFixture();
  const directory = truncated.directoryOffsets[0];
  if (directory === undefined) throw new Error("Missing resource directory");
  truncated.bytes.writeUInt16LE(0xffff, directory + 12);
  truncated.bytes.writeUInt16LE(2, directory + 14);
  await writeFile(truncatedPath, truncated.bytes);

  const paddingPath = join(root, "raw-padding.exe");
  const padding = peResourceFixture();
  const data = padding.dataOffsets[0];
  if (data === undefined) throw new Error("Missing padding fixture data entry");
  padding.bytes.writeUInt32LE(
    0x2000 + padding.bytes.readUInt32LE(padding.sectionAt + 8),
    data,
  );
  padding.bytes.writeUInt32LE(4, data + 4);
  await writeFile(paddingPath, padding.bytes);

  for (const [path, reason] of [
    [join(root, "missing.exe"), "invalid_value"],
    [malformedPath, "invalid_format"],
    [truncatedPath, "invalid_format"],
    [paddingPath, "invalid_format"],
  ] as const)
    await expectPeInputFailureAcrossAdapters({
      cli,
      call,
      path,
      reason,
    });
};

const contract = toolContract("inspect_pe_resources");

const expectPeResourceNameExtentsAcrossAdapters = async (
  cli: TestCli,
  call: PeResourceCall,
  root: string,
): Promise<void> => {
  const payload = Buffer.from("text");
  const retainedName = "Evidence".repeat(5_000);
  for (const backed of [false, true]) {
    const fixture = peResourceFixture(
      false,
      [
        ...Array.from({ length: 38 }, (_, index) => ({
          type: 10,
          name: retainedName,
          language: index + 1,
          payload,
        })),
        {
          type: 11,
          name: backed ? "S".repeat(65_535) : "SECOND",
          language: 1033,
          payload,
        },
      ],
      256 * 1024,
    );
    if (!backed) {
      const resourceRoot = fixture.directoryOffsets[0];
      const nameDirectory = fixture.directoryOffsets.at(-2);
      if (resourceRoot === undefined || nameDirectory === undefined)
        throw new Error("Missing fixture resource directory");
      const nameOffset =
        fixture.bytes.readUInt32LE(nameDirectory + 16) & 0x7fff_ffff;
      // Only the length changes. The declared name cannot fit in the resource interval.
      fixture.bytes.writeUInt16LE(65_535, resourceRoot + nameOffset);
    }
    const path = join(root, `resource-name-backed-${backed}.exe`);
    await writeFile(path, fixture.bytes);
    if (!backed) {
      await expectPeInputFailureAcrossAdapters({
        cli,
        call,
        path,
        reason: "invalid_format",
      });
      continue;
    }
    const result = await cli.run({
      arguments: ["inspect-pe-resources", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "resource_constraint",
      details: {
        resource: "memory",
        reported_limits: {
          boundary: "pe_resource_metadata_bytes",
          maximum: 8 * 1024 * 1024,
          maximum_metadata_bytes: 8 * 1024 * 1024,
        },
      },
    });
    const response = await call({ path });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response)).toEqual({ error: result.json });
  }
};

const expectPeWordAlignedRecordsAcrossAdapters = async (input: {
  readonly cli: TestCli;
  readonly call: PeResourceCall;
  readonly root: string;
}): Promise<void> => {
  const { cli, call, root } = input;
  for (const { plus, identities } of [
    { plus: false, identities: { type: 10, name: 1, language: "AB" } },
    { plus: true, identities: { type: "AB", name: 1, language: 1033 } },
  ]) {
    const payload = Buffer.from("opaque resource");
    const fixture = peResourceFixture(
      plus,
      [{ ...identities, payload }],
      65536,
      2,
    );
    const expectedOffset = fixture.dataOffsets[0];
    if (expectedOffset === undefined) throw new Error("Missing PE data entry");
    expect(expectedOffset % 4).toBe(2);
    if (typeof identities.type === "string")
      expect(fixture.directoryOffsets.some((offset) => offset % 4 === 2)).toBe(
        true,
      );
    const path = join(root, `word-aligned-${plus}.exe`);
    await writeFile(path, fixture.bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-resources", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const report = peResourcesSchema.parse(evidence.normalized_result);
    expect(report.coverage).toMatchObject({ status: "complete", resources: 1 });
    expect(report.resources[0]?.data_entry_location).toEqual({
      offset: expectedOffset,
      bytes: 16,
    });
    expect(report.resources[0]?.payload.sha256).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );
    const response = await call({ path });
    expect(response.isError).not.toBe(true);
    expect(
      contract.outputSchema.parse(response.structuredContent).normalized_result,
    ).toEqual(evidence.normalized_result);
    expect((await readFile(path)).equals(fixture.bytes)).toBe(true);
  }
};

const expectPeMappingOwnershipAcrossAdapters = async (
  cli: TestCli,
  call: PeResourceCall,
  root: string,
): Promise<void> => {
  for (const collision of [false, true]) {
    const fixture = peResourceFixture(false, [
      { type: 10, name: 1, language: 1033, payload: Buffer.from("DATA") },
    ]);
    const data = fixture.dataOffsets[0];
    if (data === undefined) throw new Error("Missing PE data entry");
    let bytes = fixture.bytes;
    bytes.writeUInt32LE(0x300, data);
    bytes.writeUInt32LE(0, data + 4);
    if (collision) {
      bytes.writeUInt16LE(2, 0x86);
      const at = fixture.sectionAt + 40;
      bytes.writeUInt32LE(4, at + 8);
      bytes.writeUInt32LE(0x300, at + 12);
      bytes.writeUInt32LE(4, at + 16);
      bytes.writeUInt32LE(bytes.length, at + 20);
      bytes = Buffer.concat([bytes, Buffer.alloc(4)]);
    }
    const path = join(root, `empty-header-collision-${collision}.exe`);
    await writeFile(path, bytes);
    if (collision) {
      await expectPeInputFailureAcrossAdapters({
        cli,
        call,
        path,
        reason: "invalid_format",
      });
      expect((await readFile(path)).equals(bytes)).toBe(true);
      continue;
    }
    const result = await cli.run({
      arguments: ["inspect-pe-resources", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const response = await call({ path });
    expect(response.isError).not.toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.subject).toEqual(evidence.subject);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    expect(evidence.normalized_result).toMatchObject({
      coverage: { status: "complete", resources: 1 },
      resources: [{ payload: { location: { offset: 0x300, bytes: 0 } } }],
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  }
};

const expectPeInventoriesAcrossAdapters = async (
  cli: TestCli,
  call: PeResourceCall,
  root: string,
): Promise<void> => {
  for (const plus of [false, true]) {
    const fixture = peResourceFixture(plus);
    const virtualSize = fixture.bytes.readUInt32LE(fixture.sectionAt + 8);
    const secondIcon = fixture.dataOffsets[1];
    if (secondIcon === undefined)
      throw new Error("Missing second icon data entry");
    fixture.bytes.writeUInt32LE(0x2000 + virtualSize, secondIcon);
    fixture.bytes.writeUInt32LE(0, secondIcon + 4);
    const path = join(root, `resource${plus ? "64" : "32"}.exe`);
    await writeFile(path, fixture.bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-resources", path, "--json"],
      freshProcess: true,
    });
    expect(result.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const report = peResourcesSchema.parse(evidence.normalized_result);
    expect(evidence.subject?.identity).toMatchObject({
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    });
    expect(fileIdentity(evidence.subject).architecture).toBe(
      plus ? "x86_64" : "x86",
    );
    expect(report.coverage).toMatchObject({
      status: "complete",
      resources: 5,
    });
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
      bytes: fixture.bytes.length,
    });
    expect(report.resources[0]?.payload.sha256).toBe(
      createHash("sha256").update("ICON").digest("hex"),
    );
    expect(report.resources[1]?.payload).toMatchObject({
      location: { offset: 0x400 + virtualSize, bytes: 0 },
      sha256: createHash("sha256").update("").digest("hex"),
    });
    expect(
      report.resources.find(({ name }) => name.kind === "name")?.name,
    ).toMatchObject({ kind: "name", name: "7", utf16le_hex: "3700" });
    expect(report.icon_groups[0]?.images).toMatchObject([
      {
        resource_id: 1,
        candidate_resource_indices: [0, 1],
        same_language_resource_index: 0,
      },
      {
        resource_id: 99,
        candidate_resource_indices: [],
        same_language_resource_index: null,
      },
    ]);
    const response = await call({ path });
    expect(response.isError).not.toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.subject).toEqual(evidence.subject);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    const text = response.content.find(({ type }) => type === "text");
    if (text?.type !== "text") throw new Error("Missing MCP text Evidence");
    expect(contract.outputSchema.parse(JSON.parse(text.text)).evidence_id).toBe(
      evidence.evidence_id,
    );
    expect(Buffer.compare(await readFile(path), fixture.bytes)).toBe(0);
  }
};

const expectPeEmptyBranchesAcrossAdapters = async (
  cli: TestCli,
  call: PeResourceCall,
  root: string,
): Promise<void> => {
  for (const shared of [false, true]) {
    const fixture = shared
      ? peResourceFixture(true, [{ type: 10 }, { type: 11 }])
      : peResourceFixture(false, [
          { type: "10" },
          { type: 10 },
          { type: 11 },
          { type: 20, name: "7" },
          { type: 20, name: 7 },
          { type: 99, name: 1, language: 1033, payload: Buffer.from("opaque") },
        ]);
    if (shared) {
      // Two distinct root identities point to exactly the same empty table.
      fixture.bytes.writeUInt32LE(
        fixture.bytes.readUInt32LE(0x400 + 20),
        0x400 + 28,
      );
    }
    const path = join(
      root,
      shared ? "shared-empty64.exe" : "empty-branches32.exe",
    );
    await writeFile(path, fixture.bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-resources", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const response = await call({ path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    const report = peResourcesSchema.parse(evidence.normalized_result);
    const paths = report.directories.map((directory) =>
      directory.path.map((identity) =>
        identity.kind === "id" ? identity.id : identity.name,
      ),
    );
    expect(paths).toEqual(
      shared
        ? [[], [10], [11]]
        : [[], ["10"], [10], [11], [20], [20, "7"], [20, 7], [99], [99, 1]],
    );
    expect(report.coverage).toEqual({
      status: "complete",
      examined_entries: shared ? 2 : 9,
      resources: shared ? 0 : 1,
    });
    for (const directory of report.directories)
      expect(directory.entry_locations).toHaveLength(directory.path.length);
    expect(report.directories[0]?.entry_locations).toEqual([]);
    if (shared) {
      expect(report.resources).toEqual([]);
      expect(report.directories[1]?.location).toEqual(
        report.directories[2]?.location,
      );
      expect(report.directories[1]?.entry_locations).toEqual([
        { offset: 0x400 + 16, bytes: 8 },
      ]);
      expect(report.directories[2]?.entry_locations).toEqual([
        { offset: 0x400 + 24, bytes: 8 },
      ]);
    } else {
      expect(report.directories[1]?.path).toEqual([
        {
          kind: "name",
          name: "10",
          utf16le_hex: "31003000",
          location: { offset: 0x400 + 56, bytes: 6 },
        },
      ]);
      expect(report.directories[5]?.path[1]).toMatchObject({
        kind: "name",
        name: "7",
        utf16le_hex: "3700",
      });
      const resource = report.resources[0]!;
      expect(resource.payload.sha256).toBe(
        createHash("sha256").update("opaque").digest("hex"),
      );
      expect(report.directories.at(-1)).toMatchObject({
        path: [resource.type, resource.name],
        entry_locations: resource.entry_locations.slice(0, 2),
      });
    }
    expect(fileIdentity(evidence.subject).sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    expect(Buffer.compare(await readFile(path), fixture.bytes)).toBe(0);
  }
};

cliTest(
  "inspects PE32/PE32+ resources through compiled CLI and real stdio MCP without an active target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-resource-acceptance-");
    const { client } = await connectLocalToolsMcp();
    const inventory = await client.listTools();
    const definition = inventory.tools.find(
      ({ name }) => name === contract.name,
    );
    if (definition === undefined)
      throw new Error("Missing PE resource tool contract");
    expect(inventory.tools).toContainEqual(
      expect.objectContaining({
        name: contract.name,
        annotations: expect.objectContaining({
          readOnlyHint: false,
          openWorldHint: false,
        }),
      }),
    );
    const call: PeResourceCall = (arguments_) =>
      client.callTool(
        { name: definition.name, arguments: arguments_ },
        { toolDefinition: withCanonicalOutputSchema(definition) },
      );
    const sessionDefinition = inventory.tools.find(
      ({ name }) => name === "binary_session",
    );
    if (sessionDefinition === undefined)
      throw new Error("Missing binary_session tool contract");
    const session = await client.callTool(
      { name: sessionDefinition.name, arguments: {} },
      { toolDefinition: withCanonicalOutputSchema(sessionDefinition) },
    );
    expect(session.isError, JSON.stringify(session)).not.toBe(true);
    const status = toolContract("binary_session").outputSchema.parse(
      session.structuredContent,
    ).result;
    expect(
      status.tool_availability.groups.find((group) =>
        group.names.includes("inspect_pe_resources"),
      ),
    ).toMatchObject({ available: true });
    await expectPeInventoriesAcrossAdapters(cli, call, root);
    await expectPeEmptyBranchesAcrossAdapters(cli, call, root);
    await expectPeWordAlignedRecordsAcrossAdapters({
      cli,
      call,
      root,
    });
    await expectPeMappingOwnershipAcrossAdapters(cli, call, root);
    await expectPeResourceNameExtentsAcrossAdapters(cli, call, root);
    await expectPeInputFailuresAcrossAdapters({
      cli,
      call,
      root,
    });
    const absent = peResourceFixture();
    absent.bytes.fill(0, absent.directoryAt, absent.directoryAt + 8);
    const path = join(root, "absent.exe");
    await writeFile(path, absent.bytes);
    const empty = await call({ path });
    expect(empty.isError).not.toBe(true);
    expect(
      contract.outputSchema.parse(empty.structuredContent).normalized_result,
    ).toMatchObject({
      directory: null,
      directories: [],
      resources: [],
      coverage: { status: "complete", resources: 0 },
    });
    for (const arguments_ of [
      { path, max_file_bytes: 64 },
      { path: "relative.exe" },
      { path, extra: true },
    ]) {
      const rejected = await call(arguments_);
      expect(rejected.isError).toBe(true);
      expect(
        contract.outputSchema.safeParse(rejected.structuredContent).success,
      ).toBe(false);
    }
    const damaged = peResourceFixture();
    // A subdirectory entry pointing back at the root is a cycle. A short
    // directory Size is not damage: the loader ignores it.
    damaged.bytes.writeUInt32LE(0x80000000, (damaged.entryOffsets[0] ?? 0) + 4);
    const badPath = join(root, "damaged.exe");
    await writeFile(badPath, damaged.bytes);
    const rejected = await call({ path: badPath });
    expect(rejected.isError).toBe(true);
    expect(
      contract.outputSchema.safeParse(rejected.structuredContent).success,
    ).toBe(false);
    await client.ping();
  },
);
