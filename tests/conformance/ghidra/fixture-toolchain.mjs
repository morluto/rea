import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);

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
  pspCompiler: { fallback: "psp-gcc" },
  pspReadelf: { fallback: "psp-readelf" },
  pspObjdump: { fallback: "psp-objdump" },
});

/** The command a fixture runs for `tool`. */
export const fixtureCommand = (tool) =>
  (tool.variable === undefined ? undefined : process.env[tool.variable]) ??
  tool.fallback;

/** A command that must run `--version`, and whose output may need a name. */
const runs = (tool, banner) => ({
  tool,
  need: banner === undefined ? "run" : `report ${String(banner)}`,
  arguments: ["--version"],
  banner,
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
  },
];

const gnuReadelf = /^GNU readelf\b/u;
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
    runs(tools.mipsAssembler, /GNU assembler/u),
    runs(tools.mipsLinker, /GNU ld/u),
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
    runs(tools.riscvReadelf),
    runs(tools.riscvObjdump),
  ],
});

const firstLine = (text) =>
  String(text ?? "")
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();

/** Why `requirement` is unmet on this host, or undefined when it is met. */
const unmet = async (requirement) => {
  const command = fixtureCommand(requirement.tool);
  try {
    const { stdout } = await execute(command, requirement.arguments, {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (requirement.banner === undefined || requirement.banner.test(stdout))
      return undefined;
    return `--version reported ${JSON.stringify(firstLine(stdout) ?? "")}`;
  } catch (cause) {
    if (cause?.code === "ENOENT") return "command not found";
    return firstLine(cause?.stderr) ?? firstLine(cause?.message) ?? "failed";
  }
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
