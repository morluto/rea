import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "../../lib/verifier-file-sha256.mjs";
import {
  artifactCli,
  artifactMcpResult,
  artifactMcpCall,
  withArtifactMcp,
  withBundleResourcesMcp,
} from "../../lib/artifact-e2e.mjs";
import { requireMcpToolError } from "../../lib/mcp-verifier-results.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "../../lib/verifier-fixture.mjs";

if (process.platform !== "darwin")
  throw new Error(
    "Asset catalog E2E requires macOS, Xcode actool and assetutil",
  );
const exec = promisify(execFile);
await exec("/usr/bin/xcrun", ["--find", "actool"]);
await exec("/usr/bin/xcrun", ["--find", "clang"]);
await exec("/usr/bin/assetutil", ["--version"]);
const fixture = await VerifierFixture.open({ prefix: "rea-asset-e2e-" });
const root = fixture.path;
let report;
await withVerifierFixture(fixture, async () => {
  const app = join(root, "Fixture.app");
  const resources = join(app, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await exec("/usr/bin/xcrun", [
    "clang",
    fileURLToPath(
      new URL(
        "../../../tests/conformance/interface-builder/fixture.c",
        import.meta.url,
      ),
    ),
    "-o",
    join(app, "Contents", "MacOS", "Fixture"),
  ]);
  await writeFile(
    join(app, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>dev.rea.asset-fixture</string></dict></plist>',
  );
  await exec("/usr/bin/xcrun", [
    "actool",
    fileURLToPath(
      new URL(
        "../../../tests/conformance/native/Assets.xcassets",
        import.meta.url,
      ),
    ),
    "--compile",
    resources,
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    "12.0",
  ]);
  const raw = JSON.parse(
    (
      await exec("/usr/bin/assetutil", [
        "--info",
        join(resources, "Assets.car"),
      ])
    ).stdout,
  );
  const sha256 = await sha256File(join(resources, "Assets.car"));
  const executableSha256 = await sha256File(
    join(app, "Contents", "MacOS", "Fixture"),
  );
  const cli = await artifactCli("inspect-asset-catalog", app);
  assert.deepEqual(
    cli.records.map(({ metadata }) => metadata),
    raw,
  );
  assert.equal(cli.catalogs[0].sha256, sha256);
  assert.ok(
    cli.records.some(
      ({ asset_name, metadata }) =>
        asset_name === "FixtureColor" && metadata.AssetType === "Color",
    ),
  );
  await withBundleResourcesMcp(app, async (client) => {
    assert.deepEqual(
      await artifactMcpResult(client, "inspect_asset_catalog"),
      cli,
    );
    const first = await artifactMcpResult(client, "inspect_asset_catalog", {
      limit: 1,
    });
    assert.equal(first.next_offset, 1);
    const next = await artifactMcpResult(client, "inspect_asset_catalog", {
      offset: first.next_offset,
    });
    assert.deepEqual([...first.records, ...next.records], cli.records);
    const invalid = await artifactMcpCall(client, {
      name: "inspect_asset_catalog",
      arguments: { offset: -1 },
    });
    // appleAssetCatalogInputSchema requires an inclusive offset minimum of 0.
    // projectInputIssues reports that bound as out_of_range.
    assert.partialDeepStrictEqual(requireMcpToolError(invalid), {
      code: "invalid_request",
      details: {
        operation: "inspect_asset_catalog",
        issues: [{ path: ["offset"], reason: "out_of_range", minimum: 0 }],
      },
    });
  });
  const { resource_root, target_sha256, ...resourcePayload } = cli;
  assert.equal(resource_root.executable_sha256, null);
  assert.equal(target_sha256, null);
  await withArtifactMcp(app, async (client) => {
    const binary = await artifactMcpResult(client, "inspect_asset_catalog");
    assert.equal(binary.target_sha256, executableSha256);
    assert.deepEqual(binary, {
      ...resourcePayload,
      target_sha256: executableSha256,
    });
  });
  report = {
    ok: true,
    mocked: false,
    cli: true,
    stdio_mcp: true,
    records: raw.length,
    pagination: true,
    malformed_input_rejected: true,
  };
});
process.stdout.write(`${JSON.stringify(report)}\n`);
