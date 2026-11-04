#!/usr/bin/env node

// Exercise the public one-shot CLI on a caller-owned saved project. The report
// is intentionally synthetic; it is not a claim about Ghidra's analysis history.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const installation = process.env.GHIDRA_INSTALL_DIR;
if (!installation || !process.env.JAVA_HOME)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR and JAVA_HOME to caller-installed Ghidra and JDK 21.",
  );
const root = await mkdtemp(join(tmpdir(), "rea-function-bundle-"));
const target = join(root, "fixture");
const projectDir = join(root, "project");
const scriptDir = join(root, "scripts");
const source = join(root, "fixture.c");
const project = join(projectDir, "SourceControl.gpr");
const repo = resolve(process.cwd());
const hash = (data) => createHash("sha256").update(data).digest("hex");
const tree = async (directory, prefix = "") => {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await tree(path, relative)));
    else if (entry.isFile())
      result.push([relative, hash(await readFile(path))]);
    else throw new Error(`Unexpected project entry: ${relative}`);
  }
  return result;
};
const run = async (command, args, options = {}) =>
  exec(command, args, {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
try {
  await mkdir(projectDir);
  await mkdir(scriptDir);
  await writeFile(
    source,
    "__attribute__((noinline)) int leaf(int x) { return x + 1; }\nint main(void) { return leaf(2); }\n",
  );
  await writeFile(
    join(scriptDir, "SetHistory.java"),
    `import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Program;
public class SetHistory extends GhidraScript {
  public void run() throws Exception {
    currentProgram.getOptions(Program.PROGRAM_INFO).setString("REA disabled analyzers", "{\\"format\\":\\"rea-ghidra-disabled-analyzers-v1\\",\\"analyzers\\":[{\\"name\\":\\"Synthetic historical control\\",\\"status\\":\\"disabled\\"}]}");
  }
}
`,
  );
  await run(process.env.REA_CC ?? "cc", ["-O0", "-g", source, "-o", target]);
  await run(join(installation, "support", "analyzeHeadless"), [
    projectDir,
    "SourceControl",
    "-import",
    target,
    "-scriptPath",
    scriptDir,
    "-postScript",
    "SetHistory.java",
  ]);
  const before = await tree(projectDir);
  const targetHash = hash(await readFile(target));
  const env = {
    ...process.env,
    REA_GHIDRA_PROJECT_PATH: project,
    REA_GHIDRA_PROGRAM_NAME: "fixture",
  };
  const cli = join(repo, "scripts", "rea.mjs");
  for (const detail of ["complete", "summary"]) {
    const output = join(root, `${detail}.json`);
    const { stdout } = await run(
      process.execPath,
      [
        cli,
        "function",
        target,
        "main",
        "--provider",
        "ghidra",
        "--detail",
        detail,
        "--evidence_output",
        output,
        "--format",
        "json",
        "--full-output",
      ],
      { env },
    );
    assert.equal(JSON.parse(stdout).ok, true);
    const bundle = JSON.parse(await readFile(output, "utf8"));
    const parent = bundle.records.find(
      (record) => record.operation === "analyze_function",
    );
    assert.ok(parent, "function observation missing from bundle");
    assert.ok(
      parent.evidence_links.length,
      "fixture did not produce a linked historical source",
    );
    const records = new Map(
      bundle.records.map((record) => [record.evidence_id, record]),
    );
    for (const record of bundle.records)
      for (const link of record.evidence_links)
        assert.ok(records.has(link), `bundle omits linked Evidence ${link}`);
    assert.ok(
      parent.evidence_links.some(
        (id) => records.get(id)?.operation === "health",
      ),
      "historical health source missing",
    );
  }
  const existing = join(root, "existing.json");
  await writeFile(existing, "caller-owned\n");
  let failure;
  try {
    await run(
      process.execPath,
      [
        cli,
        "function",
        target,
        "main",
        "--provider",
        "ghidra",
        "--detail",
        "summary",
        "--evidence_output",
        existing,
        "--format",
        "json",
        "--full-output",
      ],
      { env },
    );
    assert.fail("existing output unexpectedly overwritten");
  } catch (error) {
    if (error.code !== 1) throw error;
    failure = JSON.parse(error.stdout);
  }
  assert.equal(await readFile(existing, "utf8"), "caller-owned\n");
  assert.equal(failure.ok, false);
  assert.equal(failure.error.details.source_closure.complete, true);
  assert.ok(
    failure.error.details.source_closure.records.some(
      (record) => record.operation === "health",
    ),
  );
  assert.equal(hash(await readFile(target)), targetHash);
  assert.deepEqual(await tree(projectDir), before);
  process.stdout.write(
    `PASS Ghidra function bundles: complete, summary, no-overwrite; target and project unchanged (${targetHash})\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
