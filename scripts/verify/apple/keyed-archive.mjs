import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  artifactCli,
  artifactMcpResult,
  withArtifactMcp,
} from "../../lib/artifact-e2e.mjs";

if (process.platform !== "darwin")
  throw new Error(
    "Real Foundation keyed archive verification requires macOS and Xcode Swift tools",
  );
const root = await mkdtemp(join(tmpdir(), "rea-keyed-fixture-"));
try {
  const archive = join(root, "model.plist");
  await promisify(execFile)("/usr/bin/xcrun", [
    "swift",
    "-module-cache-path",
    join(root, "modules"),
    fileURLToPath(
      new URL(
        "../../../tests/conformance/native/keyed-archive.swift",
        import.meta.url,
      ),
    ),
    archive,
  ]);
  const graph = await artifactCli("inspect-keyed-archive", archive);
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  assert.equal(graph.archive_sha256, digest);
  assert.equal(graph.target_sha256, digest);
  await withArtifactMcp(archive, async (client) => {
    assert.deepEqual(
      await artifactMcpResult(client, "inspect_keyed_archive"),
      graph,
    );
    const page = await artifactMcpResult(client, "inspect_keyed_archive", {
      offset: 1,
      limit: 1,
    });
    assert.deepEqual(page.objects, [graph.objects[1]]);
    assert.equal(page.next_offset, 2);
    const invalid = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: { path: "../other.plist" },
    });
    assert.equal(invalid.isError, true);
  });
  const xml = join(root, "model.xml.plist");
  await promisify(execFile)("/usr/bin/plutil", [
    "-convert",
    "xml1",
    "-o",
    xml,
    archive,
  ]);
  const xmlGraph = await artifactCli("inspect-keyed-archive", xml);
  const expected = JSON.parse(
    await readFile(
      new URL(
        "../../../tests/fixtures/golden/keyed-archive/graph.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(xmlGraph).filter(
        ([key]) =>
          !["archive_path", "archive_sha256", "target_sha256"].includes(key),
      ),
    ),
    expected,
  );
  assert.deepEqual(
    graph.references.map(({ source, path, target, status }) => ({
      source,
      path,
      target,
      status,
    })),
    xmlGraph.references.map(({ source, path, target, status }) => ({
      source,
      path,
      target,
      status,
    })),
  );
  if (
    graph?.archive_format !== "binary-plist" ||
    !graph.references.some(
      (link) =>
        link.source !== null &&
        link.source === link.target &&
        link.status === "resolved",
    ) ||
    !graph.objects.some((item) => item.class_name?.includes("ReaArchiveRecord"))
  )
    throw new Error(
      `Real Foundation archive graph drifted: ${JSON.stringify(graph)}`,
    );
  const record = graph.objects.find((item) =>
    item.class_name?.includes("ReaArchiveRecord"),
  );
  if (
    graph.references.filter(
      (link) => link.target === record.id && link.source !== record.id,
    ).length < 2
  )
    throw new Error("Real shared object identity was not preserved");
  const uidRoot = join(root, "uid-root.plist");
  await promisify(execFile)("/usr/bin/xcrun", [
    "swift",
    "-module-cache-path",
    join(root, "modules"),
    fileURLToPath(
      new URL(
        "../../../tests/conformance/native/keyed-archive-uid-root.swift",
        import.meta.url,
      ),
    ),
    uidRoot,
  ]);
  const uidRootXml = join(root, "uid-root.xml.plist");
  await promisify(execFile)("/usr/bin/plutil", [
    "-convert",
    "xml1",
    "-o",
    uidRootXml,
    uidRoot,
  ]);
  for (const path of [uidRoot, uidRootXml]) {
    const uidGraph = await artifactCli("inspect-keyed-archive", path);
    assert.deepEqual(
      uidGraph.references.map(({ source, path, target, status }) => ({
        source,
        path,
        target,
        status,
      })),
      [{ source: null, path: ["UID"], target: 1, status: "resolved" }],
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, mocked: false, cli: true, stdio_mcp: true, xml_golden: true, uid_named_root: true, format: graph.archive_format, objects: graph.total_objects, references: graph.total_references, shared_identity: true, cyclic_identity: true, target_classes_instantiated_by_reader: false })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
