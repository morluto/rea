import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CATALOG_IDENTITY, CLI_COMMAND_NAMES } from "../src/catalogIdentity.js";
import { PACKAGE_METADATA } from "../src/generatedPackageMetadata.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "../src/identity.js";
import { createServerIdentity } from "../src/serverIdentity.js";
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
    expect(CLI_COMMAND_NAMES).toHaveLength(28);
    expect(new Set(CLI_COMMAND_NAMES).size).toBe(28);
    expect(CATALOG_IDENTITY.counts).toEqual({
      cli_commands: 28,
      mcp_tools: 68,
      mcp_prompts: 6,
      mcp_resources: 2,
      mcp_resource_templates: 7,
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
    const policy = { processCaptureEnabled: true, evidenceFileRoots: 1 };
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

});
