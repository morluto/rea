import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";

import { importVerifierSource } from "../../../scripts/lib/verifier-source-loader.mjs";

/**
 * The host commands the cross-architecture Ghidra fixtures build and inspect
 * with. Each names the environment variable that selects it and the command
 * used when that variable is unset; fixtures and checks resolve commands only
 * through `fixtureCommand`, so the prerequisite check probes what they run.
 */
export const FIXTURE_TOOLS = Object.freeze({
  mipsClang: { variable: "REA_MIPS_CLANG", fallback: "clang" },
  mipsAssembler: { variable: "REA_MIPS_AS", fallback: "mips-linux-gnu-as" },
  mipsLinker: { variable: "REA_MIPS_LD", fallback: "mips-linux-gnu-ld" },
  mipsReadelf: { variable: "REA_MIPS_READELF", fallback: "readelf" },
  ppcClang: { variable: "REA_PPC_CLANG", fallback: "clang" },
  ppcReadelf: { variable: "REA_PPC_READELF", fallback: "readelf" },
  riscvClang: { variable: "REA_RISCV_CLANG", fallback: "clang" },
  riscvLinker: { variable: "REA_RISCV_LLD", fallback: "ld.lld" },
  riscvReadelf: { variable: "REA_RISCV_READELF", fallback: "llvm-readelf" },
  riscvObjdump: { variable: "REA_RISCV_OBJDUMP", fallback: "llvm-objdump" },
  // The PSPSDK build runs these by name; no variable selects them.
  make: { fallback: "make" },
  pspConfig: { fallback: "psp-config" },
  pspCompiler: { fallback: "psp-gcc" },
  pspReadelf: { fallback: "psp-readelf" },
  pspObjdump: { fallback: "psp-objdump" },
});

/** The command a fixture runs for `tool`. */
export const fixtureCommand = (tool) =>
  (tool.variable === undefined ? undefined : process.env[tool.variable]) ??
  tool.fallback;

const firstLine = (text) =>
  String(text ?? "")
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();

/**
 * A command that must answer `arguments` (default `--version`), with output
 * matching `banner` when the fixture reads a particular tool's output.
 */
const runs = (tool, banner, args = ["--version"]) => ({
  tool,
  need: banner === undefined ? "run" : `report ${String(banner)}`,
  arguments: args,
  accepts: (stdout) =>
    banner === undefined || banner.test(stdout)
      ? undefined
      : `${args.join(" ")} reported ${JSON.stringify(firstLine(stdout) ?? "")}`,
});

/**
 * A Clang that generates code for `target`; with `lld` it also links it with
 * ld.lld, which prints its version and exits without writing an output.
 */
const targets = (tool, target, { lld = false } = {}) => [
  {
    tool,
    need: lld
      ? `generate and link ${target} code with -fuse-ld=lld`
      : `generate ${target} code`,
    arguments: [
      `--target=${target}`,
      ...(lld ? ["-fuse-ld=lld", "-nostdlib", "-Wl,--version"] : ["-c"]),
      "-x",
      "c",
      devNull,
      "-o",
      devNull,
    ],
    accepts: () => undefined,
  },
];

/** The PSPSDK root whose build rules the fixture Makefile includes. */
const pspsdk = {
  tool: FIXTURE_TOOLS.pspConfig,
  need: "report a PSPSDK path with lib/build.mak",
  arguments: ["--pspsdk-path"],
  accepts: async (stdout) => {
    const path = firstLine(stdout);
    if (path === undefined) return "--pspsdk-path reported nothing";
    try {
      await access(join(path, "lib", "build.mak"));
      return undefined;
    } catch {
      return `--pspsdk-path reported ${JSON.stringify(path)}, which has no lib/build.mak`;
    }
  },
};

const gnuReadelf = /^GNU readelf\b/u;
// The RISC-V fixture parses LLVM's attribute layout and disassembles one
// symbol with --disassemble-symbols, which GNU binutils do not provide.
const llvm = /\bLLVM\b/u;
const tools = FIXTURE_TOOLS;

/** What each lane's fixtures and independent readers run. */
export const LANE_TOOLCHAINS = Object.freeze({
  mips: [
    ...targets(tools.mipsClang, "mipsel-linux-gnu", { lld: true }),
    ...targets(tools.mipsClang, "mips-linux-gnu", { lld: true }),
    runs(tools.mipsReadelf, gnuReadelf),
  ],
  psp: [
    runs(tools.make),
    pspsdk,
    runs(tools.pspCompiler),
    runs(tools.pspReadelf),
    runs(tools.pspObjdump),
  ],
  "mips-relocatable": [
    ...targets(tools.mipsClang, "mipsel-linux-gnu"),
    ...targets(tools.mipsClang, "mips-linux-gnu"),
    runs(tools.mipsReadelf, gnuReadelf),
  ],
  "mips-shared": [
    // GNU tools name their configured target; a host-native assembler or
    // linker answers --version but cannot build MIPS16 code.
    runs(tools.mipsAssembler, /GNU assembler[\s\S]*target of .mips/u),
    runs(tools.mipsLinker, /GNU ld[\s\S]*\belf32\w*mip/u, ["-V"]),
    runs(tools.mipsReadelf),
  ],
  ppc: [
    ...targets(tools.ppcClang, "powerpc-unknown-linux-gnu", { lld: true }),
    runs(tools.ppcReadelf, gnuReadelf),
  ],
  dol: [
    ...targets(tools.ppcClang, "powerpc-unknown-linux-gnu", { lld: true }),
    runs(tools.ppcReadelf, gnuReadelf),
  ],
  riscv: [
    ...targets(tools.riscvClang, "riscv32-unknown-elf"),
    ...targets(tools.riscvClang, "riscv64-unknown-elf"),
    runs(tools.riscvLinker),
    runs(tools.riscvReadelf, llvm),
    runs(tools.riscvObjdump, llvm),
  ],
  // The ESP image and flash lanes build ESP32-C3 ELF files with the same
  // RISC-V Clang, linking through --ld-path; esptool is checked by the lane.
  esp: [
    ...targets(tools.riscvClang, "riscv32-unknown-elf"),
    runs(tools.riscvLinker),
  ],
});

let ownedCommand;
/** Probes run through the shared owned-command runner, which owns their process group. */
const runOwnedCommand = async () => {
  ownedCommand ??= importVerifierSource(
    new URL("../../../src/process/OwnedCommand.ts", import.meta.url).href,
    import.meta.url,
  );
  return (await ownedCommand).runOwnedCommand;
};

/** Why `requirement` is unmet on this host, or undefined when it is met. */
const unmet = async (requirement) => {
  const run = await runOwnedCommand();
  let stdout;
  try {
    const snapshot = await run(
      {
        command: fixtureCommand(requirement.tool),
        arguments: requirement.arguments,
        runId: randomUUID(),
        expectedCommand: null,
        env: { ...process.env, LC_ALL: "C" },
      },
      { timeoutMs: 10_000, diagnosticBytes: 1024 * 1024 },
    );
    stdout = snapshot.stdout.text;
  } catch (cause) {
    // A probe whose process group could not be confirmed stopped is not a
    // missing tool; that failure stays the caller's to report.
    if (cause?.cleanupFailure != null) throw cause;
    if (cause?.code === "ENOENT" || cause?.processError?.code === "ENOENT")
      return "command not found";
    return (
      firstLine(cause?.snapshot?.stderr?.text) ??
      firstLine(cause?.snapshot?.stdout?.text) ??
      firstLine(cause?.message) ??
      "failed"
    );
  }
  return requirement.accepts(stdout);
};

/**
 * Refuse a lane, before it allocates a workspace, when this host lacks a
 * command its fixtures run. The refusal names each missing capability, the
 * command probed and the variable that selects another one.
 */
export async function requireLaneToolchain(lane) {
  const requirements = LANE_TOOLCHAINS[lane];
  if (requirements === undefined)
    throw new Error(`No fixture toolchain is declared for lane ${lane}`);
  const missing = [];
  for (const requirement of requirements) {
    const reason = await unmet(requirement);
    if (reason === undefined) continue;
    const command = fixtureCommand(requirement.tool);
    const selected =
      requirement.tool.variable === undefined
        ? command
        : `${requirement.tool.variable}=${command}`;
    missing.push(`- ${selected} must ${requirement.need}: ${reason}`);
  }
  if (missing.length > 0)
    throw new Error(
      [
        `Missing prerequisite: the ${lane} lane's fixture toolchain (no workspace was created).`,
        ...missing,
        "Install the missing commands, or set each variable to a command that provides it.",
      ].join("\n"),
    );
}
