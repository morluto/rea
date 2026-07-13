import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

const exec = promisify(execFile);

/** Verify the packed CLI's persistent investigation and idempotent reuse. */
export async function verifyPackagedInvestigation(input) {
  const artifactArchiveV2 = join(input.workspace, "artifact-v2.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("app/main.js", new TextReader("main(2);"));
  await writer.add("app/new.js", new TextReader("feature();"));
  await writeFile(artifactArchiveV2, await writer.close());
  const workspacePath = join(input.evidenceRoot, "versions.json");
  const args = [
    "investigate-versions",
    input.artifactArchive,
    artifactArchiveV2,
    workspacePath,
    "--workspace-name",
    "package-versions",
    "--yes",
    "--json",
  ];
  const investigated = await runJson(input.cli, args, input.environment);
  const reused = await runJson(input.cli, args, input.environment);
  const persisted = JSON.parse(await readFile(workspacePath, "utf8"));
  if (
    investigated.operation !== "find_changed_behavior" ||
    investigated.normalized_result?.behavior_status !== "unknown" ||
    investigated.normalized_result?.investigation_run?.run_id === undefined ||
    reused.evidence_id !== investigated.evidence_id ||
    persisted.revision !== 3 ||
    persisted.runs?.[0]?.status !== "complete"
  )
    throw new Error("packaged persistent investigation CLI failed");
}

async function runJson(command, args, environment) {
  const output = await exec(command, args, { env: environment });
  return JSON.parse(output.stdout);
}
