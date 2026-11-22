import { createVerifierCommands } from "../../../scripts/lib/verify-commands.mjs";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const MARKER = "REA_TEST_RESOLVED ";
// Dependencies and composition modules used by one command family; startup
// must not resolve them just to register the complete command catalog.
const DEFERRED_IMPORTS = [
  {
    name: "inspect-byte-entropy",
    path: "/dist/composition/binaryDiagnostics/byteEntropy.js",
  },
  {
    name: "guided-workflows",
    path: "/dist/application/GuidedWorkflowAccess.js",
  },
  {
    name: "direct-analysis",
    path: "/dist/application/DirectAnalysis.js",
  },
  {
    name: "direct-analysis-status",
    path: "/dist/application/DirectAnalysisStatus.js",
  },
  {
    name: "doctor",
    path: "/dist/application/Doctor.js",
  },
  {
    name: "doctor-runtime",
    path: "/dist/doctorRuntime.js",
  },
  {
    name: "setup",
    path: "/dist/application/Setup.js",
  },
  {
    name: "setup-host",
    path: "/dist/application/SetupHost.js",
  },
  {
    name: "uninstall",
    path: "/dist/application/Uninstall.js",
  },
  {
    name: "update",
    path: "/dist/application/Update.js",
  },
  {
    name: "update-runtime",
    path: "/dist/application/UpdateRuntime.js",
  },
  {
    name: "catalog-identity",
    path: "/dist/contracts/catalog/catalogIdentity.js",
  },
  {
    name: "server-identity",
    path: "/dist/process/ServerIdentity.js",
  },
  {
    name: "tool-contracts",
    path: "/dist/contracts/toolContracts.js",
  },
  {
    name: "playwright-core",
    path: "/node_modules/playwright-core/",
  },
  {
    name: "isomorphic-git",
    path: "/node_modules/isomorphic-git/",
  },
  {
    name: "binary-composition",
    path: "/dist/composition/binary.js",
  },
  {
    name: "javascript-application",
    path: "/dist/application/javascript/JavaScriptApplicationService.js",
  },
  {
    name: "javascript-workflows",
    path: "/dist/application/javascript/JavaScriptApplicationWorkflowService.js",
  },
  {
    name: "javascript-semantic-trace",
    path: "/dist/application/javascript/JavaScriptSemanticTraceService.js",
  },
  {
    name: "electron-observation",
    path: "/dist/application/javascript/ElectronObservationService.js",
  },
  {
    name: "electron-active-observation",
    path: "/dist/application/javascript/ElectronActiveObservationService.js",
  },
  {
    name: "javascript-runtime-reconciliation",
    path: "/dist/application/javascript/JavaScriptRuntimeReconciliationService.js",
  },
  {
    name: "android-application",
    path: "/dist/application/android/AndroidApplicationService.js",
  },
  {
    name: "apple-application",
    path: "/dist/application/apple/AppleApplicationService.js",
  },
  {
    name: "reconstruction-coverage",
    path: "/dist/application/ReconstructionCoverageService.js",
  },
  {
    name: "reconstruction-obligation-ledger",
    path: "/dist/application/ReconstructionObligationLedgerService.js",
  },
  {
    name: "environment-source",
    path: "/dist/application/environment/environmentSource.js",
  },
  {
    name: "environment-export",
    path: "/dist/application/environment/environmentExport.js",
  },
  {
    name: "environment-server",
    path: "/dist/server/environment/serveEnvironment.js",
  },
  {
    name: "mcp-registration",
    path: "/dist/cli/mcpRegistration.js",
  },
] as const;

const HEAVY_SHARED_MODULES = [
  {
    name: "analysis-view-service",
    path: "/dist/application/analysisView/AnalysisViewService.js",
  },
  {
    name: "analysis-view-result",
    path: "/dist/domain/analysisView/analysisViewResult.js",
  },
  {
    name: "session-tool-contracts",
    path: "/dist/contracts/sessionToolContracts.js",
  },
  {
    name: "evidence-bundle-commands",
    path: "/dist/application/EvidenceBundleCommands.js",
  },
  ...DEFERRED_IMPORTS,
] as const;

// Report each resolved deferred package on stderr without changing resolution.
const createResolutionHook = (
  entries: readonly { readonly name: string; readonly path: string }[],
): string =>
  `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
const imports = ${JSON.stringify(entries)};
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    const name = imports.find((item) => {
      if (resolved.url.includes(item.path)) return true;
      if (!item.path.startsWith("/dist/") || !item.path.endsWith(".js")) return false;
      const facade = "/dist/cli-runtime/" + item.path.slice(6, -3).split("/").join("__") + "-";
      const shared = "/dist/cli-runtime/" + item.path.slice(item.path.lastIndexOf("/") + 1, -3) + "-";
      return resolved.url.includes(facade) || resolved.url.includes(shared);
    });
    if (name !== undefined)
      process.stderr.write(${JSON.stringify(MARKER)} + name.name + "\\n");
    return resolved;
  },
});
`)}`;

const resolvedMarkers = (stderr: string): ReadonlySet<string> =>
  new Set(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(MARKER))
      .map((line) => line.slice(MARKER.length)),
  );

const resolvedPackages = async (
  arguments_: readonly string[],
  entries: readonly {
    readonly name: string;
    readonly path: string;
  }[] = DEFERRED_IMPORTS,
): Promise<ReadonlySet<string>> => {
  const commands = await createVerifierCommands();
  onTestFinished(() => commands.close());
  const { stderr } = await withVerifierCleanup(
    () =>
      commands.exec(
        process.execPath,
        [`--import=${createResolutionHook(entries)}`, ...arguments_],
        { cwd: process.cwd(), maxBuffer: 16 * 1_024 * 1_024, timeout: 15_000 },
      ),
    [() => commands.close()],
  );
  return resolvedMarkers(stderr);
};

const evaluate = (source: string): readonly string[] => [
  "--input-type=module",
  "--eval",
  source,
];

describe("CLI startup imports", () => {
  it("detects each deferred package when its command code loads", async () => {
    await expect(
      resolvedPackages(
        evaluate(
          'await import("./dist/application/environment/environmentSource.js");',
        ),
      ),
    ).resolves.toContain("environment-source");
    await expect(
      resolvedPackages(
        evaluate(
          'await import("./dist/application/environment/environmentExport.js");',
        ),
      ),
    ).resolves.toContain("environment-export");
    const missingBrowser = join(
      await createTestTempDirectory("rea-startup-browser-"),
      "missing-browser",
    );
    const scenario = {
      browser: { mode: "launch", executable_path: missingBrowser },
      environment: { viewport: { width: 1, height: 1 } },
    };
    await expect(
      resolvedPackages(
        evaluate(
          `const { openPlaywrightScenarioBrowser } = await import("./dist/browser/PlaywrightScenarioBrowser.js"); await openPlaywrightScenarioBrowser(${JSON.stringify(scenario)}, {}).catch(() => undefined);`,
        ),
      ),
    ).resolves.toContain("playwright-core");
    const source = await createTestTempDirectory("rea-startup-imports-");
    await mkdir(join(source, ".git"));
    await expect(
      resolvedPackages(
        evaluate(
          `const { readReferenceSourceVcs } = await import("./dist/application/ReferenceSourceVcsAdapter.js"); const { ArtifactResourceScope } = await import("./dist/resources/ArtifactResourceScope.js"); const resources = new ArtifactResourceScope(); try { await readReferenceSourceVcs(${JSON.stringify(source)}, resources); } finally { await resources.close(); }`,
        ),
      ),
    ).resolves.toContain("isomorphic-git");
    await expect(
      resolvedPackages(["scripts/rea.mjs", "mcp", "add", "--help"]),
    ).resolves.toContain("mcp-registration");
  });

  it("does not load command-specific code to register the command catalog", async () => {
    await expect(
      resolvedPackages(["scripts/rea.mjs", "--help"]),
    ).resolves.toEqual(new Set());
    await expect(
      resolvedPackages(evaluate('await import("./dist/cli.js");')),
    ).resolves.toEqual(new Set());
  });

  it("renders guidance without loading the tool catalog or provider composition", async () => {
    await expect(
      resolvedPackages([
        "scripts/rea.mjs",
        "guided-workflows",
        "--action",
        "render",
        "--workflow-id",
        "investigate_feature",
        "--arguments-json",
        JSON.stringify({ feature: "offline search" }),
        "--json",
      ]),
    ).resolves.toEqual(new Set(["guided-workflows"]));
  });

  it("does not load native provider composition for JavaScript application analysis", async () => {
    const source = await createTestTempDirectory("rea-cli-js-startup-");
    await mkdir(join(source, "src"));
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "startup-fixture",
        version: "1.0.0",
        main: "src/index.js",
      }),
    );
    await writeFile(
      join(source, "src/index.js"),
      "export const answer = 42;\n",
    );

    await expect(
      resolvedPackages([
        "scripts/rea.mjs",
        "analyze-javascript-application",
        source,
        "--json",
      ]),
    ).resolves.toEqual(new Set(["javascript-application"]));
  });

  it("loads native provider composition when a provider operation is called", async () => {
    const resolved = await resolvedPackages(
      evaluate(
        'const { createDirectAnalysis } = await import("./dist/composition/directAnalysis.js"); await createDirectAnalysis({}).runSessionStatus();',
      ),
    );
    expect(resolved).toContain("binary-composition");
    expect(resolved).not.toContain("direct-analysis");
    expect(resolved).toContain("direct-analysis-status");
    expect(resolved).toContain("server-identity");
    expect(resolved).toContain("catalog-identity");
    expect(resolved).toContain("tool-contracts");
  });
});

describe("CLI one-shot command imports", () => {
  it("loads only the selected diagnostic factory for a standalone command", async () => {
    const directory = await createTestTempDirectory(
      "rea-cli-diagnostics-imports-",
    );
    const input = join(directory, "bytes");
    await writeFile(input, "Some bytes to inspect.");
    await expect(
      resolvedPackages(
        ["scripts/rea.mjs", "inspect-byte-entropy", input, "--json"],
        HEAVY_SHARED_MODULES,
      ),
    ).resolves.toEqual(new Set(["inspect-byte-entropy"]));
  });

  it("loads summary projection and bundle delivery only when requested", async () => {
    const source = await createTestTempDirectory("rea-cli-js-summary-imports-");
    await writeFile(join(source, "index.js"), "export const answer = 42;\n");
    const command = [
      "scripts/rea.mjs",
      "analyze-javascript-application",
      source,
      "--json",
    ];
    const output = join(
      await createTestTempDirectory("rea-cli-js-delivery-"),
      "evidence.json",
    );
    await expect(
      resolvedPackages(command, HEAVY_SHARED_MODULES),
    ).resolves.toEqual(new Set(["javascript-application"]));
    await expect(
      resolvedPackages(
        [...command, "--detail", "summary", "--evidence_output", output],
        HEAVY_SHARED_MODULES,
      ),
    ).resolves.toEqual(
      new Set([
        "javascript-application",
        "analysis-view-result",
        "analysis-view-service",
        "evidence-bundle-commands",
      ]),
    );
  });
});

describe("Bundled heavy startup controls", () => {
  it("detects bundled heavy modules through native command and AnalysisView runs", async () => {
    await expect(
      resolvedPackages(
        ["scripts/rea.mjs", "match-native-functions", "--help"],
        HEAVY_SHARED_MODULES,
      ),
    ).resolves.toContain("session-tool-contracts");
    await expect(
      resolvedPackages(
        ["scripts/rea.mjs", "inspect-analysis-view", "--help"],
        HEAVY_SHARED_MODULES,
      ),
    ).resolves.toContain("analysis-view-result");
    const viewDir = await createTestTempDirectory("rea-startup-view-");
    const samplePath = join(viewDir, "sample.bin");
    const viewInputPath = join(viewDir, "view.json");
    await writeFile(samplePath, "hello world 1234".repeat(40));
    const entropyCommands = await createVerifierCommands();
    onTestFinished(() => entropyCommands.close());
    const { stdout: evidenceJson } = await withVerifierCleanup(
      () =>
        entropyCommands.exec(
          process.execPath,
          ["scripts/rea.mjs", "inspect-byte-entropy", samplePath, "--json"],
          {
            cwd: process.cwd(),
            maxBuffer: 16 * 1_024 * 1_024,
            timeout: 15_000,
          },
        ),
      [() => entropyCommands.close()],
    );
    await writeFile(
      viewInputPath,
      JSON.stringify({
        source: { kind: "inline", evidence: JSON.parse(evidenceJson) },
        view: { kind: "summary" },
      }),
    );
    const viewResolved = await resolvedPackages(
      ["scripts/rea.mjs", "inspect-analysis-view", viewInputPath, "--json"],
      HEAVY_SHARED_MODULES,
    );
    expect(viewResolved).toContain("analysis-view-service");
    expect(viewResolved).toContain("analysis-view-result");
  });

  it("does not load AnalysisView or session contracts for single-command startup", async () => {
    for (const command of [
      "inspect-uefi-nvram",
      "inspect-sqlite-database",
      "inspect-wasm-artifact",
      "guided-workflows",
    ]) {
      await expect(
        resolvedPackages(
          ["scripts/rea.mjs", command, "--help"],
          HEAVY_SHARED_MODULES,
        ),
      ).resolves.toEqual(new Set());
    }
  });
});

describe("MCP startup imports", () => {
  it("initializes and lists tools over stdio with HTTP-only environment settings present", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        `--import=${createResolutionHook(DEFERRED_IMPORTS)}`,
        "scripts/rea.mjs",
        "mcp",
      ],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        MCP_HOST: " ",
        MCP_PORT: "not-a-port",
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const client = new Client(
      { name: "rea-startup-imports", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain(
        "capture_browser_scenario",
      );
    } finally {
      await client.close();
    }
    const resolved = resolvedMarkers(stderr);
    expect(stderr).not.toContain("MCP transport listening");
    expect(resolved).not.toContain("playwright-core");
    expect(resolved).not.toContain("isomorphic-git");
  });
});
