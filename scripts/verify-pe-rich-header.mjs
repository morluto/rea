/**
 * Compare inspect_pe_rich_header with pefile's parse_rich_header on real PE
 * files. Pass files or directories; set REA_PEFILE_PYTHON to a Python that
 * imports pefile 2024.8.26.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createPeRichHeaderService } from "../dist/composition/binaryDiagnostics.js";
import { MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES } from "../dist/domain/native/peRichHeader.js";

const PE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".sys",
  ".ocx",
  ".cpl",
  ".efi",
  ".scr",
]);

const PEFILE_SCRIPT = `
import json, sys, pefile
for path in json.load(open(sys.argv[1], encoding="utf-8")):
    try:
        pe = pefile.PE(path, fast_load=True)
        rich = pe.parse_rich_header()
        warned = any("Rich Header" in w for w in pe.get_warnings())
        row = None if rich is None else {
            "key": int.from_bytes(rich["key"], "little"),
            "values": rich["values"],
            "warned": warned,
        }
        print(json.dumps({"path": path, "rich": row}))
    except Exception as error:
        print(json.dumps({"path": path, "error": type(error).__name__}))
`;

const python = process.env.REA_PEFILE_PYTHON;
assert.ok(python, "Set REA_PEFILE_PYTHON to a Python with pefile 2024.8.26.");
const roots = process.argv.slice(2);
assert.ok(roots.length > 0, "Pass at least one PE file or directory.");

const collect = async (path, found) => {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    found.push(resolve(path));
    return;
  }
  if (!info.isDirectory()) return;
  let names;
  try {
    names = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child, found);
    else if (
      entry.isFile() &&
      PE_EXTENSIONS.has(extname(entry.name).toLowerCase())
    )
      found.push(resolve(child));
  }
};

const files = [];
for (const root of roots) {
  await stat(root);
  await collect(root, files);
}

const service = createPeRichHeaderService();
const rea = new Map();
try {
  for (const path of files) {
    const result = await service.inspect({
      path,
      max_file_bytes: MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES,
    });
    rea.set(
      path,
      result.ok ? result.value.normalized_result : { error: result.error._tag },
    );
  }
} finally {
  await service.close();
}

const scratch = await mkdtemp(join(tmpdir(), "rea-pe-rich-header-"));
const pefile = new Map();
try {
  const list = join(scratch, "files.json");
  await writeFile(list, JSON.stringify(files));
  const output = execFileSync(python, ["-I", "-c", PEFILE_SCRIPT, list], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  for (const line of output.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    pefile.set(row.path, row);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const summary = {
  files: files.length,
  rea_errors: [],
  absent: 0,
  malformed: 0,
  present: 0,
  checksum_matches: 0,
  checksum_mismatches: [],
  pefile_errors: [],
  compared_with_pefile: 0,
  agree: 0,
  disagree: [],
  pefile_layout_differs: [],
};

const sameRecord = (record, other) => {
  if (other === null) return record.state === "absent";
  if (record.state !== "present" || record.location.offset !== 0x80)
    return false;
  const values = record.entries.flatMap(({ product_id, build, count }) => [
    ((product_id << 16) | build) >>> 0,
    count,
  ]);
  return (
    other.key === record.key &&
    other.values.length === values.length &&
    other.values.every((value, index) => value === values[index])
  );
};

for (const path of files) {
  const report = rea.get(path);
  const theirs = pefile.get(path);
  if (report === undefined || "error" in report) {
    summary.rea_errors.push({ path, error: report?.error ?? "missing" });
    continue;
  }
  const record = report.rich_header;
  if (record.state === "absent") summary.absent += 1;
  if (record.state === "malformed") summary.malformed += 1;
  if (record.state === "present") {
    summary.present += 1;
    if (record.checksum.matches) summary.checksum_matches += 1;
    else summary.checksum_mismatches.push(path);
  }
  if (theirs === undefined || theirs.error !== undefined) {
    summary.pefile_errors.push({ path, error: theirs?.error ?? "missing" });
    continue;
  }
  const other = theirs.rich;
  // Exclusions come from pefile's own result, never from REA's. pefile warns
  // when the DWORD at 0x80 is not DanS, and it never searches before 0x80.
  const outsidePefileLayout =
    other === null
      ? record.state !== "absent" && record.footer_location.offset < 0x80
      : other.warned;
  if (outsidePefileLayout) {
    summary.pefile_layout_differs.push({
      path,
      rea: record.state,
      rea_offset: record.state === "present" ? record.location.offset : null,
      pefile: other === null ? "none" : "warned",
    });
    continue;
  }
  summary.compared_with_pefile += 1;
  if (sameRecord(record, other)) summary.agree += 1;
  else
    summary.disagree.push({
      path,
      rea: record.state,
      pefile: other === null ? "none" : "present",
    });
}

const firstPresent = files.find(
  (path) => rea.get(path)?.rich_header?.state === "present",
);
if (firstPresent !== undefined) {
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve("scripts/rea.mjs"),
        "inspect-pe-rich-header",
        firstPresent,
        "--max-file-bytes",
        String(MAX_INSPECT_PE_RICH_HEADER_FILE_BYTES),
        "--json",
      ],
      { encoding: "utf8", timeout: 60000 },
    ),
  );
  assert.deepEqual(cli.normalized_result, rea.get(firstPresent));
}

console.log(JSON.stringify(summary, null, 2));
assert.ok(
  summary.compared_with_pefile > 0,
  "No file was compared with pefile.",
);
assert.equal(summary.disagree.length, 0, "rea and pefile disagree");
