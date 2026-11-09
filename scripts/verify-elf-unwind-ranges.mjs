/**
 * Build a stripped C++ ELF and compare .eh_frame FDE starts with readelf.
 * Not part of the default check. Exits non-zero when the host has no ELF
 * C++ compiler or no readelf.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";

/**
 * Every probe, compiler driver and inspection runs as an owned process tree,
 * so a timeout or close also stops the children a driver starts. Close it
 * before removing the compiled outputs.
 */
const commands = await createVerifierCommands();

/**
 * Ctrl-C or SIGTERM aborts the running command instead of ending Node, so the
 * owned process trees and the compiled outputs are still cleaned up below.
 */
const interruption = new AbortController();
const interrupt = (signal) =>
  interruption.abort(
    new Error(`ELF unwind ranges verifier interrupted by ${signal}`),
  );
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

const run = (command, args, timeout) =>
  commands.exec(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    signal: interruption.signal,
  });

const available = async (command) => {
  // zig has no --version flag; it reports through the `version` subcommand.
  const probe = command === "zig" ? ["version"] : ["--version"];
  try {
    await run(command, probe, 30000);
    return true;
  } catch (failure) {
    // An absent tool or a failing probe means the candidate is unavailable.
    if (failure?.code === "ENOENT" || typeof failure?.code === "number")
      return false;
    throw failure;
  }
};

const firstAvailable = async (candidates) => {
  for (const command of candidates)
    if (await available(command)) return command;
  return null;
};

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

const compileArguments = (compiler, source, output) => {
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

const compile = async (compiler, source, output) => {
  await run(compiler, compileArguments(compiler, source, output), 120000);
};

const stripArguments = (stripper, input, output) => {
  if (stripper === "llvm-strip") return ["--strip-all", "-o", output, input];
  if (stripper === "llvm-objcopy") return ["--strip-all", input, output];
  if (stripper === "zig") return ["objcopy", "--strip-all", input, output];
  return ["-o", output, input];
};

const stripCopy = async (stripper, input, output) => {
  await run(stripper, stripArguments(stripper, input, output), 30000);
};

// llvm-readelf has no --debug-dump=frames; llvm-dwarfdump --eh-frame prints
// the same `pc=<start>..<end>` FDE ranges under an `.eh_frame contents:` head.
const frameDump = async (readelf, path) =>
  (
    await run(
      readelf,
      readelf === "llvm-dwarfdump"
        ? ["--eh-frame", path]
        : ["--debug-dump=frames", path],
      30000,
    )
  ).stdout;

const ehFrameStarts = async (readelf, path) => {
  const stdout = await frameDump(readelf, path);
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

const inspectedStarts = async (path) => {
  const starts = new Set();
  let offset = 0;
  for (;;) {
    const { stdout: output } = await run(
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
      60000,
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

// The root holds every compiled image. Remove it only after the owned
// commands have settled, and keep it when their cleanup failed.
let root;
let commandsClosed = false;
let unavailable = false;
await withVerifierCleanup(async () => {
  const compiler = await firstAvailable(["zig", "clang++", "g++"]);
  const readelf = await firstAvailable([
    "readelf",
    "greadelf",
    "llvm-dwarfdump",
  ]);
  const stripper = await firstAvailable([
    "llvm-strip",
    "llvm-objcopy",
    "zig",
    "strip",
  ]);
  if (compiler === null || readelf === null || stripper === null) {
    console.error(
      "verify:elf:unwind-ranges needs an ELF C++ compiler (zig, clang++, or g++) and readelf (readelf, greadelf, or llvm-dwarfdump), plus a stripper.",
    );
    unavailable = true;
    return;
  }
  root = await mkdtemp(join(tmpdir(), "rea-elf-unwind-"));
  const source = join(root, "ranges.cpp");
  const unstripped = join(root, "ranges.unstripped");
  const stripped = join(root, "ranges.stripped");
  await writeFile(source, sourceText);
  await compile(compiler, source, unstripped);
  await stripCopy(stripper, unstripped, stripped);
  const expected = await ehFrameStarts(readelf, unstripped);
  const observed = await inspectedStarts(stripped);
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
}, [
  async () => {
    await commands.close();
    commandsClosed = true;
  },
  async () => {
    if (commandsClosed && root !== undefined)
      await rm(root, { recursive: true, force: true });
  },
  async () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  },
]);
// A signal that lands outside a command, such as during the final rm, is still
// a failed run. An earlier failure already left through the rejection above.
if (interruption.signal.aborted) throw interruption.signal.reason;
if (unavailable) process.exitCode = 1;
