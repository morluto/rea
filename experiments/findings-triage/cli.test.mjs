import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeOutput } from "./cli.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const triagePath = here("fixture/triage.json");
const bundlePath = here("fixture/bundle.ndjson");
const scratch = await mkdtemp(join(tmpdir(), "findings-triage-test-"));
after(() => rm(scratch, { recursive: true, force: true }));

const run = (...args) =>
  spawnSync(process.execPath, [here("cli.mjs"), ...args], {
    encoding: "utf8",
  });
const inputs = (triage = triagePath, bundle = bundlePath) => [
  "--triage",
  triage,
  "--bundle",
  bundle,
];
const scratchFile = async (name, content) => {
  const path = join(scratch, name);
  await writeFile(path, content);
  return path;
};
const listFiles = async (directory) =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    .sort();

test("validate --json reports a clean fixture", () => {
  const result = run("validate", ...inputs(), "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("render matches the golden output byte for byte", async () => {
  const out = join(scratch, "render");
  const result = run("render", ...inputs(), "--out", out);
  assert.equal(result.status, 0, result.stderr);
  if (process.platform !== "win32")
    assert.equal((await stat(out)).mode & 0o777, 0o700);
  const expected = here("fixture/expected");
  const files = await listFiles(expected);
  assert.deepEqual(await listFiles(out), files);
  for (const file of files)
    assert.equal(
      await readFile(join(out, file), "utf8"),
      await readFile(join(expected, file), "utf8"),
      file,
    );
});

test("validation errors exit 1 and render writes nothing", async () => {
  const triage = JSON.parse(await readFile(triagePath, "utf8"));
  triage.findings[0].evidence_ids = [];
  const invalid = await scratchFile("invalid.json", JSON.stringify(triage));
  const validated = run("validate", ...inputs(invalid), "--json");
  assert.equal(validated.status, 1);
  assert.deepEqual(JSON.parse(validated.stdout), [
    {
      code: "finding_without_evidence",
      path: "findings.0.evidence_ids",
      message: "A defect finding must cite Evidence",
    },
    {
      code: "verdict_requires_observed_basis",
      path: "findings.0.verdict",
      message:
        "A defect verdict needs an observed or derived record that is not analyst inference",
    },
  ]);
  const out = join(scratch, "invalid-out");
  assert.equal(run("render", ...inputs(invalid), "--out", out).status, 1);
  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("render refuses an existing output directory", async () => {
  const existing = await mkdtemp(join(scratch, "existing-"));
  assert.equal(run("render", ...inputs(), "--out", existing).status, 2);
  assert.deepEqual(await readdir(existing), []);
});

test("a failed write removes the partial output directory", async () => {
  const out = join(scratch, "partial");
  // The second path needs report.md to be a directory, after it was written.
  const files = new Map([
    ["report.md", "written\n"],
    ["report.md/nested.md", "never written\n"],
  ]);
  await assert.rejects(writeOutput(out, files));
  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("usage, IO and unparseable inputs exit 2", async () => {
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const malformed = await scratchFile("malformed.json", "{");
  const record = await scratchFile(
    "record.json",
    JSON.stringify(bundle.records[0]),
  );
  bundle.records[0].limitations.push("Edited after export.");
  const tampered = await scratchFile("tampered.json", JSON.stringify(bundle));
  const cases = [
    [],
    ["publish", ...inputs()],
    ["validate", ...inputs(), "extra"],
    ["validate", ...inputs(), "--force"],
    ["validate", "--triage", triagePath],
    ["render", ...inputs(), "--json", "--out", join(scratch, "unused")],
    ["validate", ...inputs(join(scratch, "missing.json"))],
    ["validate", ...inputs(malformed)],
    ["validate", ...inputs(triagePath, malformed)],
    ["validate", ...inputs(triagePath, record)],
    ["validate", ...inputs(triagePath, tampered)],
  ];
  for (const args of cases) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
});
