import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { cargoManifestSchema } from "../../../src/domain/cargoManifest/cargoManifest.js";

const fixture = new URL(
  "../../fixtures/cargo/workspace-member.toml",
  import.meta.url,
);

cliTest(
  "inventories Cargo manifest declarations through MCP without resolving or building",
  async () => {
    const root = await createTestTempDirectory("rea-public-cargo-manifest-");
    const path = join(root, "Cargo.toml");
    const text = await readFile(fixture, "utf8");
    await writeFile(path, text);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application,session",
    });

    const response = await call("inspect_cargo_manifest", { path });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    const report = cargoManifestSchema.parse(evidence.normalized_result);

    expect(report.artifact).toMatchObject({ path, bytes: text.length });
    expect(report.packages).toMatchObject([
      { name: "rea-fixture-app", version: "0.3.1", edition: "2021" },
    ]);
    expect(report.workspace).toMatchObject({
      members: ["crates/*"],
      resolver: "2",
    });

    const byPointer = new Map(
      report.dependencies.map((dependency, index) => [
        dependency.source_pointer,
        index,
      ]),
    );
    const dependency = (pointer: string) =>
      report.dependencies[byPointer.get(pointer) ?? -1];

    expect(dependency("/dependencies/serde")).toMatchObject({
      source: "workspace",
      requirement: null,
    });
    expect(dependency("/dependencies/anyhow")).toMatchObject({
      source: "registry",
      requirement: "1",
    });
    expect(dependency("/dependencies/local-helper")).toMatchObject({
      source: "path",
      source_detail: "../local-helper",
    });
    expect(dependency("/dependencies/pinned-tool")).toMatchObject({
      source: "git",
      source_detail: "https://example.invalid/pinned-tool rev=abc123",
    });
    expect(dependency("/dependencies/json")).toMatchObject({
      name: "serde_json",
      alias: "json",
      optional: true,
    });
    expect(
      dependency("/target/cfg(windows)/dependencies/windows-sys"),
    ).toMatchObject({ target: "cfg(windows)", default_features: false });

    expect(report.summary).toMatchObject({
      packages: 1,
      // Five package declarations plus the [workspace.dependencies] one.
      dependencies: 7,
      workspace_dependencies: 1,
      inherited_dependencies: 1,
      git_dependencies: 1,
      path_dependencies: 1,
      target_dependencies: 1,
      diagnostics: 0,
    });
    expect(report.source_coverage).toMatchObject({
      status: "complete-within-scope",
      lockfile: "not-read",
      resolution: "not-attempted",
      workspace_member_manifests: "not-read",
      build_scripts: "not-executed",
    });
  },
);

cliTest(
  "reports a malformed Cargo manifest as a typed input failure",
  async () => {
    const root = await createTestTempDirectory("rea-malformed-cargo-manifest-");
    const path = join(root, "Cargo.toml");
    await writeFile(path, '[package\nname = "broken"\n');
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "application",
    });
    const response = await call("inspect_cargo_manifest", { path });
    expect(response.isError).toBe(true);
    const failure = parseMcpToolError(response);
    expect(failure.error.message.length).toBeGreaterThan(0);
  },
);
