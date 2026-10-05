import { readFile } from "node:fs/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  CATALOG_IDENTITY,
  CLI_COMMAND_NAMES,
} from "../../../src/catalogIdentity.js";
import { PACKAGE_METADATA } from "../../../src/generatedPackageMetadata.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../../../src/identity.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { PROMPT_CONTRACTS } from "../../../src/contracts/promptContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createServerIdentity } from "../../../src/serverIdentity.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";

const availabilityProvider = (): AnalysisProvider => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const capability: CapabilityDescriptor = {
    provider: identity,
    operation: "current_address",
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
  };
  return {
    identity: () => identity,
    capabilities: () => [capability],
    createClient: () => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }),
  };
};

const statusCapability = (
  operation: string,
  availability:
    | { readonly available: true }
    | {
        readonly available: false;
        readonly availability_code: "unsupported_host";
        readonly reason: string;
      } = { available: true },
) => ({
  operation,
  effects: {
    mutates_artifact: false,
    launches_process: false,
    may_show_ui: false,
    may_access_network: false,
    may_write_filesystem: false,
    changes_permissions: false,
    requires_root: false,
  },
  limitations: [],
  ...(availability.available
    ? { available: true as const, reason: null, availability_code: null }
    : availability),
});

describe("server and catalog identity", () => {
  it("derives package and SDK versions from canonical package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
    expect(PACKAGE_METADATA).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
      serverSdkVersion:
        packageJson.dependencies["@modelcontextprotocol/server"],
      clientSdkVersion:
        packageJson.dependencies["@modelcontextprotocol/client"],
      coreSdkVersion:
        packageLock.packages["node_modules/@modelcontextprotocol/core"].version,
    });
    expect(PRODUCT_IDENTITY.packageVersion).toBe(packageJson.version);
    expect(SDK_IDENTITY.server).toBe(
      packageJson.dependencies["@modelcontextprotocol/server"],
    );
    expect(new Set(CLI_COMMAND_NAMES).size).toBe(CLI_COMMAND_NAMES.length);
    expect(CATALOG_IDENTITY.counts).toEqual({
      cli_commands: CLI_COMMAND_NAMES.length,
      mcp_tools: TOOL_CONTRACTS.length,
      mcp_prompts: PROMPT_CONTRACTS.length,
    });
    expect(CATALOG_IDENTITY.digests.combined_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reports unknown without a live comparison and distinguishes aligned from stale", () => {
    const unknown = createServerIdentity({
      startedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(unknown.alignment.state).toBe("unknown");
    const aligned = createServerIdentity({
      startedAt: "2026-07-13T00:00:00.000Z",
      expected: {
        package_version: PRODUCT_IDENTITY.packageVersion,
        catalog_digest: CATALOG_IDENTITY.digests.combined_sha256,
        server_path: process.argv[1] ?? "unknown",
      },
    });
    expect(aligned.alignment).toMatchObject({ state: "aligned", reasons: [] });
    const stale = createServerIdentity({
      startedAt: "2026-07-13T00:00:00.000Z",
      expected: {
        package_version: "1.2.0",
        catalog_digest: "0".repeat(64),
      },
    });
    expect(stale.alignment).toMatchObject({
      state: "mcp_server_restart_required",
      reasons: ["package_version_mismatch", "catalog_digest_mismatch"],
    });
  });

  it("reports composed, host, and target-specific availability truthfully", () => {
    const policy = {
      processCaptureEnabled: true,
      investigationInputRoots: 1,
    };
    const composed = buildCapabilityInventory(
      {
        open: true,
        kind: "executable",
        format: "mach-o",
        capabilities: [
          "list_segments",
          "list_documents",
          "list_procedures",
          "list_strings",
        ].map((operation) => statusCapability(operation)),
      },
      policy,
    );
    expect(composed).toContainEqual(
      expect.objectContaining({ name: "binary_overview", available: true }),
    );
    const artifactTarget = buildCapabilityInventory(
      {
        open: true,
        kind: "artifact",
        format: "javascript",
        capabilities: [statusCapability("current_address")],
      },
      policy,
    );
    expect(artifactTarget).toContainEqual(
      expect.objectContaining({
        name: "current_address",
        available: false,
        reason: "target_unsupported",
      }),
    );
    const unsupportedHost = buildCapabilityInventory(
      {
        open: true,
        kind: "executable",
        format: "elf",
        capabilities: [
          statusCapability("inspect_macho", {
            available: false,
            availability_code: "unsupported_host",
            reason: "Native macOS utilities require macOS.",
          }),
        ],
      },
      policy,
    );
    expect(unsupportedHost).toContainEqual(
      expect.objectContaining({
        name: "inspect_macho",
        available: false,
        reason: "unsupported_host",
      }),
    );
  });
});

describe("live server identity over MCP", () => {
  it("exposes live identity, a stable catalog, and changing availability", async () => {
    const session = createTestBinarySession(availabilityProvider());
    const server = createServer(session, session);
    const client = new Client(
      { name: "identity-test", version: "9" },
      {
        capabilities: {
          elicitation: { form: {} },
        },
      },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let toolListChanges = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      toolListChanges += 1;
    });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await assertLiveIdentity(client);
      await assertSessionIdentity(client);
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("current_address");
      await client.callTool({
        name: "open_binary",
        arguments: { path: process.execPath },
      });
      expect(toolListChanges).toBe(0);
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("current_address");
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  }, 10_000);
});

const assertLiveIdentity = async (client: Client): Promise<void> => {
  const identity = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  expect(identity.structuredContent).toMatchObject({
    result: {
      server_identity: {
        package: { version: PRODUCT_IDENTITY.packageVersion },
        server: { version: PRODUCT_IDENTITY.packageVersion },
        sdk: {
          server: SDK_IDENTITY.server,
          client_test: PACKAGE_METADATA.clientSdkVersion,
        },
        client: null,
        alignment: { state: "unknown" },
      },
    },
  });
};

const assertSessionIdentity = async (client: Client): Promise<void> => {
  const status = await client.callTool({
    name: "binary_session",
    arguments: { expected_package_version: "1.2.0" },
  });
  expect(status.structuredContent).toMatchObject({
    result: {
      server_identity: {
        catalog: {
          counts: {
            mcp_tools: TOOL_CONTRACTS.length,
            cli_commands: CLI_COMMAND_NAMES.length,
          },
        },
        alignment: { state: "mcp_server_restart_required" },
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
        elicitation_form: false,
        elicitation_url: false,
        roots: false,
        sampling: false,
      },
    },
  });
};
