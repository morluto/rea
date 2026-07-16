import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { SUPPORTED_CLIENT_DEFINITIONS } from "../src/application/SupportedClients.js";
import {
  ARTIFACT_GRAPH_PROVIDER,
  JAVASCRIPT_APPLICATION_PROVIDER,
  JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
  JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER,
  MANAGED_STATIC_PROVIDER,
  MANAGED_WORKFLOW_PROVIDER,
} from "../src/application/InvestigationProviders.js";
import { CDP_BROWSER_PROVIDER_IDENTITY } from "../src/browser/CdpBrowserProvider.js";
import { CDP_ELECTRON_PROVIDER_IDENTITY } from "../src/browser/CdpElectronProvider.js";
import { CLI_COMMAND_NAMES } from "../src/cliCommandNames.js";
import { createCli } from "../src/cli.js";
import { TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";
import { analysisSnapshotSchema } from "../src/domain/analysisSnapshot.js";
import { investigationWorkspaceSchema } from "../src/domain/investigationWorkspace.js";
import {
  HOPPER_PROVIDER_IDENTITY,
  HOPPER_PROVIDER_TOOL_CONTRACTS,
} from "../src/hopper/HopperProvider.js";
import {
  GHIDRA_PROVIDER_IDENTITY,
  GHIDRA_PROVIDER_TOOL_CONTRACTS,
} from "../src/ghidra/GhidraProvider.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY } from "../src/native/NativeMacOSProvider.js";
import {
  assertDocumentationFacts,
  documentationFactIssues,
} from "../scripts/lib/docs-facts.mjs";
import { ensureGeneratedFile } from "../scripts/lib/generated-file.mjs";
import {
  createCliInventory,
  cliCommandOptionNames,
  createProductCatalog,
  serializeProductCatalog,
} from "../scripts/lib/product-catalog.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("canonical product catalog", () => {
  it("matches every source-derived checked-in product fact", async () => {
    const catalog = await createProductCatalog(root);
    expect(catalog.tools.total).toBe(TOOL_CONTRACTS.length);
    expect(
      catalog.tools.families.reduce((total, family) => total + family.count, 0),
    ).toBe(TOOL_CONTRACTS.length);
    expect(catalog.setup_clients.map(({ id }) => id)).toEqual(
      SUPPORTED_CLIENT_DEFINITIONS.map(({ name }) => name),
    );
    expect(catalog.cli.commands).toHaveLength(CLI_COMMAND_NAMES.length);
    expect(catalog.providers.map(({ id }) => id).sort()).toEqual(
      [
        HOPPER_PROVIDER_IDENTITY,
        GHIDRA_PROVIDER_IDENTITY,
        NATIVE_MACOS_PROVIDER_IDENTITY,
        ARTIFACT_GRAPH_PROVIDER,
        MANAGED_STATIC_PROVIDER,
        MANAGED_WORKFLOW_PROVIDER,
        CDP_BROWSER_PROVIDER_IDENTITY,
        CDP_ELECTRON_PROVIDER_IDENTITY,
        JAVASCRIPT_APPLICATION_PROVIDER,
        JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER,
        JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
      ]
        .map(({ id }) => id)
        .sort(),
    );
    expect(
      catalog.providers.find(({ id }) => id === HOPPER_PROVIDER_IDENTITY.id)
        ?.capabilities,
    ).toEqual(HOPPER_PROVIDER_TOOL_CONTRACTS.map(({ name }) => name).sort());
    expect(
      catalog.providers.find(({ id }) => id === GHIDRA_PROVIDER_IDENTITY.id)
        ?.capabilities,
    ).toEqual(GHIDRA_PROVIDER_TOOL_CONTRACTS.map(({ name }) => name).sort());
    expect(
      catalog.providers.find(
        ({ id }) => id === CDP_ELECTRON_PROVIDER_IDENTITY.id,
      )?.capabilities,
    ).toEqual(["inspect_electron_page", "list_electron_targets"]);
    expect(
      catalog.providers.find(
        ({ id }) => id === JAVASCRIPT_APPLICATION_PROVIDER.id,
      )?.capabilities,
    ).toEqual(["analyze_javascript_application"]);
    expect(
      catalog.providers.find(
        ({ id }) => id === JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER.id,
      )?.capabilities,
    ).toEqual(["reconcile_javascript_runtime"]);
    expect(
      catalog.providers.find(
        ({ id }) => id === JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER.id,
      )?.capabilities,
    ).toEqual([
      "compare_application_versions",
      "run_controlled_replay",
      "trace_application_feature",
    ]);
    expect(
      catalog.providers.find(({ id }) => id === MANAGED_WORKFLOW_PROVIDER.id)
        ?.capabilities,
    ).toEqual([
      "compare_managed_members",
      "import_managed_reconstruction",
      "plan_managed_runtime_correlation",
    ]);
    expect(
      z.toJSONSchema(analysisSnapshotSchema).properties?.snapshot_version,
    ).toMatchObject({
      const: catalog.schemas.find(({ id }) => id === "analysis_snapshot")
        ?.version,
    });
    expect(
      z.toJSONSchema(investigationWorkspaceSchema).properties
        ?.workspace_version,
    ).toMatchObject({
      const: catalog.schemas.find(({ id }) => id === "investigation_workspace")
        ?.version,
    });
    expect(
      JSON.parse(await readFile("docs/product-catalog.json", "utf8")),
    ).toEqual(catalog);
    expect(await serializeProductCatalog(catalog)).toBe(
      await readFile("docs/product-catalog.json", "utf8"),
    );
    await expect(
      assertDocumentationFacts(root, catalog),
    ).resolves.toBeUndefined();
    await expect(documentationFactIssues(root, catalog)).resolves.toEqual([]);
  }, 15_000);

  it("uses the same primary command names as the actual Incur router", () => {
    const inventory = createCliInventory(createCli());
    expect(inventory.primary).toEqual([...CLI_COMMAND_NAMES].sort());
    expect(inventory.aliases).toEqual([
      { name: "compare-bundles", target: "compare" },
    ]);
  });

  it("exposes the shared provider selector on every deep-analysis command", () => {
    const cli = createCli();
    for (const name of [
      "analyze",
      "inspect",
      "decompile",
      "xrefs",
      "trace",
      "function",
      "search",
    ]) {
      expect(cliCommandOptionNames(cli, name)).toContain("provider");
    }
  });

  it("reports tool, setup-client, and schema fact drift", async () => {
    const catalog = await createProductCatalog(root);
    const drifted = {
      ...catalog,
      tools: { ...catalog.tools, total: catalog.tools.total + 1 },
      setup_clients: [
        ...catalog.setup_clients,
        {
          id: "future_client",
          display_name: "Future Client",
          format: "json",
          configuration: "managed",
        },
      ],
      schemas: catalog.schemas.map((schema) =>
        schema.id === "process_capture"
          ? { ...schema, version: Number(schema.version) + 1 }
          : schema,
      ),
    };
    const issues = await documentationFactIssues(root, drifted);
    expect(
      issues.some((issue) =>
        issue.includes(`${String(catalog.tools.total + 1)}-tool`),
      ),
    ).toBe(true);
    expect(issues.some((issue) => issue.includes("Future Client"))).toBe(true);
    expect(issues.some((issue) => issue.includes("Process Capture v5"))).toBe(
      true,
    );
  });

  it("fails check mode without rewriting a stale generated artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-generated-check-"));
    temporaryRoots.push(directory);
    const path = join(directory, "catalog.json");
    await writeFile(path, "stale\n", "utf8");
    await expect(
      ensureGeneratedFile({
        path,
        source: "current\n",
        check: true,
        generateCommand: "npm run docs:generate",
      }),
    ).rejects.toThrow("missing or stale");
    expect(await readFile(path, "utf8")).toBe("stale\n");
    await expect(
      ensureGeneratedFile({
        path,
        source: "current\n",
        check: false,
        generateCommand: "npm run docs:generate",
      }),
    ).resolves.toEqual({ changed: true });
    expect(await readFile(path, "utf8")).toBe("current\n");
  });
});
