import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { silentLogger } from "../dist/logger.js";
import { runProviderAnalysis } from "../dist/application/DirectAnalysis.js";

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
        "../tests/conformance/native/keyed-archive.swift",
        import.meta.url,
      ),
    ),
    archive,
  ]);
  const observation = await runProviderAnalysis(
    archive,
    "inspect_keyed_archive",
    {},
    silentLogger,
  );
  if (observation.error !== undefined)
    throw new Error(JSON.stringify(observation.error));
  const graph = observation.normalized_result;
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
      `Real Foundation archive graph drifted: ${JSON.stringify(observation)}`,
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
  process.stdout.write(
    `${JSON.stringify({ ok: true, format: graph.archive_format, objects: graph.total_objects, references: graph.total_references, shared_identity: true, cyclic_identity: true, target_classes_instantiated_by_reader: false })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
