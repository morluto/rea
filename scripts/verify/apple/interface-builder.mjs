#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseBinaryTarget } from "../../../dist/application/BinaryTargetResolver.js";
import { ArtifactProvider } from "../../../dist/artifacts/ArtifactProvider.js";

const exec = promisify(execFile);
const fixtureRoot = await mkdtemp(join(tmpdir(), "rea-interface-builder-"));
const appPath = join(fixtureRoot, "Fixture.app");
const resourcesPath = join(appPath, "Contents", "Resources");
const executablePath = join(appPath, "Contents", "MacOS", "Fixture");
const nibPath = join(resourcesPath, "Main.nib");
const sourceRoot = fileURLToPath(
  new URL("../../../tests/conformance/interface-builder/", import.meta.url),
);

let report;
try {
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(resourcesPath, { recursive: true });
  await writeFile(
    join(appPath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>dev.rea.interface-builder-fixture</string></dict></plist>\n`,
  );
  await exec("xcrun", [
    "ibtool",
    "--errors",
    "--warnings",
    "--compile",
    nibPath,
    join(sourceRoot, "Main.xib"),
  ]);
  await exec("cc", [join(sourceRoot, "fixture.c"), "-o", executablePath]);

  const target = await parseBinaryTarget(appPath);
  if (!target.ok) throw target.error;
  const execution = await new ArtifactProvider()
    .createClient(target.value)
    .execute("decode_interface_builder", {}, {});
  if (!execution.ok) throw execution.error;

  const decoded = execution.value.result;
  assert.equal(decoded.documents.length, 1);
  assert.equal(
    decoded.documents[0]?.relative_path,
    "Contents/Resources/Main.nib",
  );
  assert.equal(decoded.documents[0]?.document_kind, "nib");
  assert.equal(decoded.documents[0]?.hierarchy_complete, true);
  assert.ok(decoded.documents[0]?.object_count > 0);
  assert.ok(decoded.documents[0]?.connection_count >= 2);

  const button = decoded.graph.nodes.find(
    (node) => node.kind === "control" && node.name === "NSButton",
  );
  const action = decoded.graph.nodes.find(
    (node) => node.kind === "action" && node.name === "runAction:",
  );
  assert.ok(button, "compiled button control was not decoded");
  assert.ok(action, "compiled action selector was not decoded");
  assert.ok(
    decoded.graph.edges.some(
      (edge) =>
        edge.relation === "target_action" &&
        edge.resolution === "observed" &&
        (edge.from === action.id || edge.to === action.id),
    ),
    "compiled target/action connection was not represented as observed",
  );
  assert.ok(
    decoded.graph.coverage.some(
      (facet) =>
        facet.facet === "archive_decode" && facet.status === "complete",
    ),
  );
  assert.equal(decoded.graph.truncated, false);

  report = {
    ok: true,
    fixture: "compiled-appkit-nib",
    provider: execution.value.provider,
    target_sha256: decoded.target_sha256,
    archive_sha256: decoded.documents[0].archive_sha256,
    objects: decoded.documents[0].object_count,
    connections: decoded.documents[0].connection_count,
    recovered_control: button.name,
    recovered_action: action.name,
    hierarchy_complete: decoded.documents[0].hierarchy_complete,
    truncated: decoded.graph.truncated,
  };
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(report)}\n`);
