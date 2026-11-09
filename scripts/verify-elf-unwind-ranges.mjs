/**
 * Build a stripped C++ ELF and compare .eh_frame FDE starts with readelf.
 * Not part of the default check. Exits non-zero when the host has no ELF
 * C++ compiler or no readelf.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const available = (command) => {
  // zig has no --version flag; it reports through the `version` subcommand.
  const probe = command === "zig" ? ["version"] : ["--version"];
  const result = spawnSync(command, probe, { encoding: "utf8" });
  return result.error === undefined && result.status === 0;
};

const firstAvailable = (commands) =>
  commands.find((command) => available(command)) ?? null;

const compiler = firstAvailable(["zig", "clang++", "g++"]);
const readelf = firstAvailable(["readelf", "greadelf", "llvm-dwarfdump"]);
const stripper = firstAvailable(["llvm-strip", "llvm-objcopy", "zig", "strip"]);
if (compiler === null || readelf === null || stripper === null) {
  console.error(
    "verify:elf:unwind-ranges needs an ELF C++ compiler (zig, clang++, or g++) and readelf (readelf, greadelf, or llvm-dwarfdump), plus a stripper.",
  );
  process.exit(1);
}

const sourceText = `
struct Guard { ~Guard(); };
Guard::~Guard() {}
int may_throw(int value) {
  Guard guard;
  if (value < 0) throw value;
  return value + 1;
}
int main() {
  try { return may_throw(1); }
  catch (int) { return 2; }
}
`;

const compileArguments = (source, output) => {
  if (compiler === "zig")
    return [
      "c++",
      "-target",
      "x86_64-linux-musl",
      "-O0",
      "-g",
      source,
      "-o",
      output,
    ];
  if (compiler === "clang++")
    return [
      "--target=x86_64-linux-gnu",
      "-O0",
      "-g",
      "-fexceptions",
      source,
      "-o",
      output,
    ];
  return ["-O0", "-g", "-fexceptions", source, "-o", output];
};

const compile = (source, output) => {
  execFileSync(compiler, compileArguments(source, output), {
    stdio: "inherit",
    timeout: 120000,
  });
};

const stripArguments = (input, output) => {
  if (stripper === "llvm-strip") return ["--strip-all", "-o", output, input];
  if (stripper === "llvm-objcopy") return ["--strip-all", input, output];
  if (stripper === "zig") return ["objcopy", "--strip-all", input, output];
  return ["-o", output, input];
};

const stripCopy = (input, output) => {
  execFileSync(stripper, stripArguments(input, output), {
    stdio: "inherit",
    timeout: 30000,
  });
};

// llvm-readelf has no --debug-dump=frames; llvm-dwarfdump --eh-frame prints
// the same `pc=<start>..<end>` FDE ranges under an `.eh_frame contents:` head.
const frameDump = (path) =>
  readelf === "llvm-dwarfdump"
    ? execFileSync(readelf, ["--eh-frame", path], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      })
    : execFileSync(readelf, ["--debug-dump=frames", path], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      });

const ehFrameStarts = (path) => {
  const stdout = frameDump(path);
  const starts = new Set();
  let inEhFrame = false;
  for (const line of stdout.split("\n")) {
    if (/Contents of the \.eh_frame\b|^\.eh_frame contents:/u.test(line)) {
      inEhFrame = true;
      continue;
    }
    if (/Contents of the \.debug_frame\b|^\.\w+ contents:/u.test(line)) {
      inEhFrame = false;
      continue;
    }
    if (!inEhFrame) continue;
    const match = /pc=(0x[0-9a-fA-F]+|[0-9a-fA-F]+)\.\./u.exec(line);
    // readelf and llvm-dwarfdump print bare hex; BigInt needs the 0x prefix.
    if (match?.[1] !== undefined)
      starts.add(
        BigInt(match[1].startsWith("0x") ? match[1] : `0x${match[1]}`),
      );
  }
  return starts;
};

const inspectedStarts = (path) => {
  const starts = new Set();
  let offset = 0;
  for (;;) {
    const output = execFileSync(
      process.execPath,
      [
        resolve("scripts/rea.mjs"),
        "inspect-elf-unwind-ranges",
        path,
        "--json",
        "--offset",
        String(offset),
        "--limit",
        "4096",
        "--max-ranges",
        "65536",
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    const report = JSON.parse(output).normalized_result;
    for (const range of report.ranges) starts.add(BigInt(range.start));
    if (report.page.next_offset === null) {
      assert.equal(report.eh_frame.status, "present");
      assert.equal(starts.size, report.coverage.total_ranges);
      return starts;
    }
    offset = report.page.next_offset;
  }
};

const root = await mkdtemp(join(tmpdir(), "rea-elf-unwind-"));
try {
  const source = join(root, "ranges.cpp");
  const unstripped = join(root, "ranges.unstripped");
  const stripped = join(root, "ranges.stripped");
  await writeFile(source, sourceText);
  compile(source, unstripped);
  stripCopy(unstripped, stripped);
  const expected = ehFrameStarts(unstripped);
  const observed = inspectedStarts(stripped);
  assert.ok(expected.size > 0, "readelf listed no .eh_frame FDEs");
  const missing = [...expected].filter((start) => !observed.has(start));
  const extra = [...observed].filter((start) => !expected.has(start));
  assert.deepEqual(
    { missing: missing.map(String), extra: extra.map(String) },
    { missing: [], extra: [] },
  );
  console.log(
    JSON.stringify({
      compiler,
      readelf,
      fde_starts: expected.size,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
