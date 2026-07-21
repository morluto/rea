import { readFile } from "node:fs/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { CATALOG_IDENTITY, CLI_COMMAND_NAMES } from "../src/catalogIdentity.js";
import { PACKAGE_METADATA } from "../src/generatedPackageMetadata.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../src/identity.js";
import { TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { TOOL_KINDS } from "../src/contracts/toolContractTypes.js";
import { createServer } from "../src/server/createServer.js";
import { createServerIdentity } from "../src/serverIdentity.js";
import { observed } from "./fixtures/analysisExecution.js";
import { buildCapabilityInventory } from "../src/application/CapabilityInventory.js";

describe("server and catalog identity", () => {
  it("derives package and SDK versions from canonical package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    expect(PACKAGE_METADATA).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
      serverSdkVersion: "2.0.0-beta.4",
      clientSdkVersion: "2.0.0-beta.4",
      coreSdkVersion: "2.0.0-beta.4",
    });
    expect(PRODUCT_IDENTITY.packageVersion).toBe(packageJson.version);
    expect(SDK_IDENTITY.server).toBe("2.0.0-beta.4");
    expect(CLI_COMMAND_NAMES).toHaveLength(55);
    expect(new Set(CLI_COMMAND_NAMES).size).toBe(55);
    expect(CATALOG_IDENTITY.counts).toEqual({
      cli_commands: 55,
      mcp_tools: TOOL_CONTRACTS.length,
      mcp_prompts: 6,
      mcp_resources: 2,
      mcp_resource_templates: 8,
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
      evidenceFileRoots: 1,
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
        ].map((operation) => ({ operation, available: true, reason: null })),
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
        capabilities: [
          { operation: "current_address", available: true, reason: null },
        ],
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
          {
            operation: "inspect_macho",
            available: false,
            reason: "Native macOS utilities require macOS.",
          },
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

  it("exposes live identity, labeled inventories, availability, and list changes", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({ name: "identity-test", version: "9" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let toolListChanges = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      toolListChanges += 1;
    });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const instructions = client.getInstructions();
      expect(instructions?.length).toBeLessThanOrEqual(512);
      expect(instructions).toContain(
        "ASAR/JavaScript -> analyze_javascript_application",
      );
      expect(instructions).toContain(
        "native binary/database -> open_binary, then binary_overview",
      );
      expect(instructions).toContain("Never repeat identical analysis");
      expect(instructions).toContain("cite Evidence IDs");
      const resource = await client.readResource({
        uri: "rea://server/identity",
      });
      const content = resource.contents[0];
      expect(content).toBeDefined();
      if (content === undefined || !("text" in content)) return;
      const live = JSON.parse(content.text);
      expect(live).toMatchObject({
        package: { version: PRODUCT_IDENTITY.packageVersion },
        server: { version: PRODUCT_IDENTITY.packageVersion },
        sdk: { server: "2.0.0-beta.4", client_test: "2.0.0-beta.4" },
        client: { name: "identity-test", version: "9" },
        alignment: { state: "unknown" },
      });
      const status = await client.callTool({
        name: "binary_session",
        arguments: {
          detail: "full",
          expected_package_version: "1.2.0",
        },
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
              available: false,
              reason: "policy_disabled",
            }),
            expect.objectContaining({
              name: "inspect_web_page",
              available: false,
              reason: "policy_disabled",
            }),
            expect.objectContaining({
              name: "analyze_javascript_application",
              available: false,
              reason: "policy_disabled",
              remediation: expect.stringContaining(
                "REA_INVESTIGATION_INPUT_ROOTS_JSON",
              ),
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
      const summary = await client.callTool({
        name: "binary_session",
        arguments: { expected_package_version: "1.2.0" },
      });
      expect(summary.structuredContent).toMatchObject({
        result: {
          view: "summary",
          open: false,
          target: null,
          alignment: { state: "mcp_server_restart_required" },
          recommended_actions: expect.any(Array),
        },
      });
      expect(JSON.stringify(summary.structuredContent)).not.toContain(
        "tool_availability",
      );
      const capabilities = await client.callTool({
        name: "binary_session",
        arguments: {
          detail: "capabilities",
          capability_family: "browser-provider",
          cursor: 0,
          limit: 1,
        },
      });
      expect(capabilities.structuredContent).toMatchObject({
        result: {
          view: "capabilities",
          capability_family: "browser-provider",
          capabilities: {
            items: [expect.objectContaining({ surface: "browser-provider" })],
            cursor: 0,
            limit: 1,
            total: expect.any(Number),
            next_cursor: expect.any(Number),
            has_more: true,
          },
        },
      });
      for (const capabilityFamily of TOOL_KINDS) {
        const familyCapabilities = await client.callTool({
          name: "binary_session",
          arguments: {
            detail: "capabilities",
            capability_family: capabilityFamily,
            limit: 100,
          },
        });
        expect(familyCapabilities.structuredContent).toMatchObject({
          result: {
            view: "capabilities",
            capability_family: capabilityFamily,
            capabilities: {
              items: expect.arrayContaining([
                expect.objectContaining({ surface: capabilityFamily }),
              ]),
              total: expect.any(Number),
            },
          },
        });
      }
      await client.callTool({ name: "close_binary", arguments: {} });
      await expect.poll(() => toolListChanges).toBeGreaterThan(0);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});
