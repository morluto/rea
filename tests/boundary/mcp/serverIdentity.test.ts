import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import {
  DEFAULT_CATALOG_IDENTITY,
  createCatalogDigestProfiles,
  createCatalogDigests,
  CLI_COMMAND_NAMES,
} from "../../../src/contracts/catalog/catalogIdentity.js";
import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { annotationsFromEffects } from "../../../src/contracts/toolEffects.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { sessionOutputSchemas } from "../../../src/contracts/toolOutputSchemaGroups.js";
import type { PromptContract } from "../../../src/contracts/promptContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createServerIdentity } from "../../../src/process/ServerIdentity.js";
import { observed } from "../../fixtures/analysisExecution.js";
import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/ports/AnalysisProvider.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const availabilityProvider = (
  operations: readonly CapabilityDescriptor["operation"][] = [
    "current_address",
  ],
): AnalysisProvider => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const capability = (
    operation: CapabilityDescriptor["operation"],
  ): CapabilityDescriptor => ({
    provider: identity,
    operation,
    available: true,
    reason: null,
    effects: {
      mutatesArtifact: false,
      launchesProcess: false,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  });
  return {
    identity: () => identity,
    capabilities: () => operations.map(capability),
    createClient: () => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }),
  };
};

describe("server and catalog identity", () => {
  it("covers target-content policy in the tool and combined digests", () => {
    const contract = toolContract("binary_session");
    const original = createCatalogDigests([contract], []);
    const changed = createCatalogDigests(
      [{ ...contract, returnsTargetContent: !contract.returnsTargetContent }],
      [],
    );
    expect(changed.combined_sha256).not.toBe(original.combined_sha256);
    expect(changed.tools_sha256).not.toBe(original.tools_sha256);
    expect(changed.prompts_sha256).toBe(original.prompts_sha256);
  });

  it("binds output schema profile and canonical output contracts into identity", () => {
    const contract = toolContract("binary_session");
    const profiles = createCatalogDigestProfiles([contract], []);
    const changed = createCatalogDigestProfiles(
      [
        {
          ...contract,
          outputSchema: z.strictObject({ profile_probe: z.literal(true) }),
        },
      ],
      [],
    );
    const { compact, off } = profiles;
    expect(off.tools_sha256).not.toBe(compact.tools_sha256);
    expect(off.combined_sha256).not.toBe(compact.combined_sha256);
    expect(off.prompts_sha256).toBe(compact.prompts_sha256);
    for (const profile of ["compact", "off"] as const) {
      expect(changed[profile].tools_sha256).not.toBe(
        profiles[profile].tools_sha256,
      );
      expect(changed[profile].combined_sha256).not.toBe(
        profiles[profile].combined_sha256,
      );
      expect(changed[profile].prompts_sha256).toBe(
        profiles[profile].prompts_sha256,
      );
    }
  });

  it("keeps registration alignment unknown when the server entrypoint is absent", () => {
    const identity = createServerIdentity({
      catalog: DEFAULT_CATALOG_IDENTITY,
      startedAt: "2026-07-13T00:00:00.000Z",
      commandPath: undefined,
      expected: { server_path: "/registered/rea.mjs" },
    });

    expect(identity.server.command_path).toBeNull();
    expect(identity.alignment).toMatchObject({
      state: "unknown",
      reasons: [],
      remediation: expect.stringContaining("entrypoint path is unavailable"),
    });
  });
});

it.skipIf(process.platform === "win32")(
  "compares the selected entrypoint through symlink and parent traversal",
  async () => {
    const root = await createTestTempDirectory("server-identity-path-");
    const scripts = join(root, "package", "scripts");
    const scratch = join(root, "scratch");
    await mkdir(scripts, { recursive: true });
    await mkdir(scratch);
    const canonical = join(scripts, "rea.mjs");
    const other = join(root, "other.mjs");
    await writeFile(canonical, "entrypoint");
    await writeFile(other, "other entrypoint");
    await symlink(scripts, join(scratch, "link"));
    const selected = `${scratch}/link/../scripts/rea.mjs`;
    // Bun selects a script through native traversal (#8844).
    const identity = (server_path: string) =>
      createServerIdentity({
        catalog: DEFAULT_CATALOG_IDENTITY,
        startedAt: "2026-07-13T00:00:00.000Z",
        commandPath: canonical,
        expected: { server_path },
        runtime: "bun",
      });

    expect(identity(selected).alignment).toMatchObject({
      state: "aligned",
      reasons: [],
    });
    expect(identity(other).alignment).toMatchObject({
      state: "mcp_server_restart_required",
      reasons: ["registration_path_mismatch"],
    });
    expect(identity(join(root, "missing.mjs")).alignment).toMatchObject({
      state: "unknown",
      reasons: [],
    });
    // Node resolves its entrypoint lexically, so this spelling runs
    // scratch/rea.mjs even though traversal through the link leaves scratch.
    // Bun traverses the link and runs a different file.
    const lexical = join(scratch, "rea.mjs");
    await writeFile(lexical, "lexical entrypoint");
    await writeFile(join(root, "package", "rea.mjs"), "traversed entrypoint");
    const crossing = (runtime: "node" | "bun") =>
      createServerIdentity({
        catalog: DEFAULT_CATALOG_IDENTITY,
        startedAt: "2026-07-13T00:00:00.000Z",
        commandPath: lexical,
        expected: { server_path: `${scratch}/link/../rea.mjs` },
        runtime,
      }).alignment;
    expect(crossing("node")).toMatchObject({ state: "aligned", reasons: [] });
    expect(crossing("bun")).toMatchObject({
      state: "mcp_server_restart_required",
      reasons: ["registration_path_mismatch"],
    });
  },
);

it("reports the connected client and compares caller expectations against the live catalog", async () => {
  const session = createTestBinarySession(availabilityProvider());
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "identity-test", version: "9" },
    {
      jsonSchemaValidator: createMcpSchemaValidation(),
      capabilities: { elicitation: { form: {} } },
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const status = await assertLiveIdentity(client);
    const statusSchema = sessionOutputSchemas.binary_session;
    expect(status.open).toBe(false);
    expect(
      statusSchema.safeParse({ result: { ...status, open: true } }).success,
    ).toBe(false);

    const digest = status.server_identity.catalog.digests.combined_sha256;
    const aligned = await client.callTool({
      name: "binary_session",
      arguments: { expected_catalog_digest: digest },
    });
    expect(
      statusSchema.parse(aligned.structuredContent).result.server_identity
        .alignment,
    ).toMatchObject({
      state: "aligned",
      reasons: [],
    });
    await assertStaleIdentity(client);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

describe("active-target availability over MCP", () => {
  it("changes availability with the target while keeping the advertised catalog stable", async () => {
    const session = createTestBinarySession(
      availabilityProvider(["inspect_macho", "inspect_artifact"]),
    );
    // Availability does not depend on compiling every advertised output schema.
    const server = createServer(
      { kind: "session", session },
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" } },
    );
    const client = new Client(
      { name: "availability-test", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const directory = await createTestTempDirectory("rea-target-availability-");
    const executable = join(directory, "tool");
    const plist = join(directory, "Info.plist");
    await writeFile(executable, machoImage({}));
    await writeFile(plist, PLIST_XML);
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const before = await readStatus(client);
      // inspect_artifact can inspect a selected path without a target.
      expect(activeTargetReasons(before)).toEqual({
        inspect_macho: "target_required",
        inspect_artifact: "available",
        inspect_managed_artifact: "available",
      });
      const call = await client.callTool({
        name: "inspect_macho",
        arguments: {},
      });
      expect(parseMcpToolError(call)).toMatchObject({
        error: { code: "target_unavailable" },
      });
      await openTarget(client, plist);
      const artifact = await readStatus(client);
      expect(activeTargetReasons(artifact)).toEqual({
        inspect_macho: "target_unsupported",
        inspect_artifact: "available",
        inspect_managed_artifact: "available",
      });
      await client.callTool({ name: "close_binary", arguments: {} });
      await openTarget(client, executable);
      const native = await readStatus(client);
      expect(activeTargetReasons(native)).toEqual({
        inspect_macho: "available",
        inspect_artifact: "available",
        inspect_managed_artifact: "available",
      });
      expect(await client.listTools()).toEqual(listed);
      await client.callTool({ name: "close_binary", arguments: {} });
      const closed = await readStatus(client);
      expect(activeTargetReasons(closed).inspect_macho).toBe("target_required");
      for (const status of [artifact, native, closed])
        expect(status.server_identity.catalog).toEqual(
          before.server_identity.catalog,
        );
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});

const PLIST_XML =
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Fixture</string></dict></plist>';

const openTarget = async (client: Client, path: string): Promise<void> => {
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path },
  });
  expect(opened.isError ?? false).toBe(false);
};

const readStatus = async (client: Client) => {
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  return sessionOutputSchemas.binary_session.parse(status.structuredContent)
    .result;
};

const activeTargetReasons = (
  status: Awaited<ReturnType<typeof readStatus>>,
) => {
  const availability = expandToolAvailability(status.tool_availability);
  return Object.fromEntries(
    ["inspect_macho", "inspect_artifact", "inspect_managed_artifact"].map(
      (name) => [name, availability.find((tool) => tool.name === name)?.reason],
    ),
  );
};

const assertLiveIdentity = async (client: Client) => {
  const identity = await client.callTool({
    name: "binary_session",
    arguments: { detail: "complete" },
  });
  const status = sessionOutputSchemas.binary_session.parse(
    identity.structuredContent,
  ).result;
  const availability = expandToolAvailability(status.tool_availability);
  expect(availability.map(({ name }) => name).sort()).toEqual(
    TOOL_CONTRACTS.map(({ name }) => name).sort(),
  );
  for (const contract of TOOL_CONTRACTS) {
    const effects = contract.sessionEffects;
    const annotations = annotationsFromEffects(effects);
    expect(availability).toContainEqual(
      expect.objectContaining({
        name: contract.name,
        surface: contract.kind,
        effects,
        annotations: {
          read_only: annotations.readOnlyHint,
          destructive: annotations.destructiveHint,
          idempotent: annotations.idempotentHint,
          open_world: annotations.openWorldHint,
        },
      }),
    );
  }
  const root = resolve(fileURLToPath(import.meta.url), "../../../..");
  const manifest = z
    .object({ name: z.string(), version: z.string() })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  const { packages } = z
    .object({
      packages: z.record(
        z.string(),
        z.object({ version: z.string().optional() }),
      ),
    })
    .parse(JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")));
  const tools = await client.listTools();
  const { prompts } = await client.listPrompts();
  expect(status.server_identity).toMatchObject({
    package: {
      name: manifest.name,
      version: manifest.version,
      root_path: root,
    },
    server: { version: manifest.version },
    sdk: {
      server: packages["node_modules/@modelcontextprotocol/server"]?.version,
      client_test:
        packages["node_modules/@modelcontextprotocol/client"]?.version,
      core: packages["node_modules/@modelcontextprotocol/core"]?.version,
    },
    client: { name: "identity-test", version: "9" },
    negotiated_protocol_version: client.getNegotiatedProtocolVersion(),
    catalog: {
      counts: {
        cli_commands: CLI_COMMAND_NAMES.length,
        mcp_tools: tools.tools.length,
        mcp_prompts: prompts.length,
      },
      digests: { combined_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    },
    alignment: { state: "unknown", reasons: [] },
  });
  return status;
};

const assertStaleIdentity = async (client: Client): Promise<void> => {
  const status = await client.callTool({
    name: "binary_session",
    arguments: {
      expected_package_version: "1.2.0",
      expected_catalog_digest: "0".repeat(64),
    },
  });
  const parsed = sessionOutputSchemas.binary_session.parse(
    status.structuredContent,
  );
  expect({
    result: {
      ...parsed.result,
      tool_availability: expandToolAvailability(
        parsed.result.tool_availability,
      ),
    },
  }).toMatchObject({
    result: {
      server_identity: {
        alignment: {
          state: "mcp_server_restart_required",
          reasons: ["package_version_mismatch", "catalog_digest_mismatch"],
        },
      },
      tool_availability: expect.arrayContaining([
        expect.objectContaining({
          name: "current_address",
          available: false,
          reason: "target_required",
        }),
        expect.objectContaining({
          name: "capture_process_scenario",
          available: process.platform !== "win32",
          reason:
            process.platform === "win32" ? "unsupported_host" : "available",
          client_requirements: {
            required: [],
            optional: [],
            missing_required: [],
            missing_optional: [],
          },
        }),
        expect.objectContaining({
          name: "inspect_web_page",
          available: false,
          reason: "provider_missing",
        }),
        expect.objectContaining({
          name: "analyze_javascript_application",
          available: true,
          reason: "available",
          remediation: null,
        }),
      ]),
      client_features: {
        elicitation_form: true,
        elicitation_url: false,
        roots: false,
        sampling: false,
      },
    },
  });
};

it("hashes the exact canonical catalog, including escaped prompt text and empty inventories", () => {
  const sha256 = (value: unknown) => {
    const canonical = canonicalize(value);
    if (canonical === undefined) throw new Error("invalid catalog fixture");
    return createHash("sha256").update(canonical).digest("hex");
  };
  const escaped = {
    name: "fixture",
    title: 'Quote " slash \\ line\u2028 é 😀',
    description: "Catalog fixture",
    objective: "Preserve the exact prompt text.",
    arguments: {
      z_last: { description: "Tab\t and newline\n", required: false },
      a_first: { description: "", required: true },
    },
    steps: [
      { instruction: "Use the selected analysis.", tools: ["binary_session"] },
    ],
  } satisfies PromptContract;
  for (const [prompts, profile] of [
    [[escaped], "off"],
    [[], "off"],
    [[], "compact"],
  ] as const) {
    const tools = { output_schema_profile: profile, catalog: [] };
    expect(createCatalogDigests([], prompts, undefined, profile)).toEqual({
      tools_sha256: sha256(tools),
      prompts_sha256: sha256(prompts),
      combined_sha256: sha256({ cli: CLI_COMMAND_NAMES, tools, prompts }),
    });
  }
});
