import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../../src/contracts/reverseEngineeringToolContracts.js";
import { rizinInputSchema } from "../../../src/domain/reverseEngineering.js";
import { rizinCommandLimitations } from "../../../src/rizin/RizinCommand.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { assertRequiredRizin } from "../../support/requiredRizin.js";
import { createProviderEnvironmentMcpHarness } from "../../support/reverseDebuggerMcpTestHelpers.js";

// Real-provider gate for execute_rizin_command's decoder and map inputs. It
// runs the Rizin found on PATH and skips without one; put another Rizin's
// bin directory first on PATH to check that version. With REA_REQUIRE_RIZIN
// set to a version, a missing or different Rizin fails instead of skipping.
const rizin = findRizin();
assertRequiredRizin("RizinDecoderInputs", rizin);
const banner = rizin === undefined ? "no Rizin on PATH" : versionBanner(rizin);

// Cortex-M vector table head (SP 0x20002000, Reset 0x08000109), then the
// Thumb instructions `bx lr` and `nop`.
const CORTEX_M_IMAGE = Buffer.from([
  0x00, 0x20, 0x00, 0x20, 0x09, 0x01, 0x00, 0x08, 0x70, 0x47, 0x00, 0xbf,
]);
// Thumb `msr primask, r0`, which only an M-profile decoder knows.
const MSR_PRIMASK = Buffer.from([0x80, 0xf3, 0x10, 0x88]);
// Thumb `bx lr; bx lr`, then `nop; nop`. As ARM32, the first word is invalid
// and the second is `svclt 0xbf00`.
const THUMB_RETURNS = Buffer.from([
  0x70, 0x47, 0x70, 0x47, 0x00, 0xbf, 0x00, 0xbf,
]);
// 6502 `nop; rts`; no host decodes 6502 by default.
const MOS_6502_IMAGE = Buffer.from([0xea, 0x60]);
// Raw images that Rizin's loaders claim unless REA passes -n. Rizin 0.9.1's
// AVR loader (bytes 1 and 3 look like rjmp) turns io.va off, so reads at the
// -m map return 0xff. The BIOS loader (a jmp 16 bytes from the end of a 64 KiB
// file) maps the file at another address in 0.7.4 and 0.9.1.
const AVR_LIKE_IMAGE = Buffer.from(
  Array.from({ length: 64 }, (_, index) =>
    index === 1 || index === 3 ? 0xc0 : index,
  ),
);
const BIOS_LIKE_IMAGE = Buffer.alloc(0x10000);
BIOS_LIKE_IMAGE.set([0x11, 0x22, 0x33, 0x44], 0);
BIOS_LIKE_IMAGE[0xfff0] = 0xea;
BIOS_LIKE_IMAGE[0xffff] = 0x5a;

const rizinContract = REVERSE_ENGINEERING_TOOL_CONTRACTS.find(
  (contract) => contract.name === "execute_rizin_command",
);
if (rizinContract === undefined)
  throw new Error("execute_rizin_command contract is missing");

const hex = (value: number): string => `0x${value.toString(16)}`;

const runRizin = async (
  input: Readonly<Record<string, string | number>>,
  image: Buffer,
) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-rizin-decoder-"));
  // The harness owns the directory, so it must exist before setup can fail.
  const { client } = await createProviderEnvironmentMcpHarness({
    directory,
    clientName: "real-rizin-decoder-inputs",
    serverOptions: { environment: { REA_RIZIN_COMMAND: rizin! } },
  });
  const path = join(directory, "image.bin");
  await writeFile(path, image);
  const toolArguments = { path, ...input };
  const response = await client.callTool({
    name: "execute_rizin_command",
    arguments: toolArguments,
  });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const evidence = rizinContract.outputSchema.parse(response.structuredContent);
  expect(evidence.normalized_result.exit_code).toBe(0);
  expect(evidence.limitations).toEqual(
    expect.arrayContaining([
      ...rizinCommandLimitations({
        ...toolArguments,
        command: String(input.command),
      }),
    ]),
  );
  return {
    lines: evidence.normalized_result.stdout.trimEnd().split("\n"),
    stderr: evidence.normalized_result.stderr,
  };
};

const mapsOf = (line: string | undefined) =>
  JSON.parse(line ?? "null") as readonly {
    readonly fd: number;
    readonly delta: number;
    readonly from: number;
  }[];

it.skipIf(rizin === undefined)(
  `applies -a, -b, -e asm.cpu= and -m to a raw Cortex-M image (${banner})`,
  async () => {
    const { lines } = await runRizin(
      {
        command:
          "e asm.arch; e asm.bits; e asm.cpu; omlj; p8 1 @ 0x07ffffff; p8 12 @ 0x08000000; p8 1 @ 0x0800000c; pi 1 @ 0x08000008",
        asm_arch: "arm",
        asm_bits: 16,
        asm_cpu: "cortexm",
        base_address: "0x08000000",
      },
      CORTEX_M_IMAGE,
    );
    expect(lines.slice(0, 3)).toEqual(["arm", "16", "cortexm"]);
    // One map: file offset 0 at the base address, and nothing mapped below
    // it or past its end.
    expect(mapsOf(lines[3])).toEqual([
      expect.objectContaining({ delta: 0, from: 0x08000000 }),
    ]);
    expect(lines.slice(4)).toEqual([
      "ff",
      CORTEX_M_IMAGE.toString("hex"),
      "ff",
      "bx lr",
    ]);
  },
);

it.skipIf(rizin === undefined)(
  `applies asm_cpu to the decoder, and echoes one Rizin lacks (${banner})`,
  async () => {
    const thumb = { asm_arch: "arm", asm_bits: 16, base_address: "0x0" };
    const plain = await runRizin({ command: "pi 1", ...thumb }, MSR_PRIMASK);
    expect(plain.lines).toEqual(["invalid"]);

    const selected = await runRizin(
      { command: "pi 1", ...thumb, asm_cpu: "cortexm" },
      MSR_PRIMASK,
    );
    expect(selected.lines).toEqual(["msr primask, r0"]);

    const unknown = await runRizin(
      { command: "e asm.cpu; pi 1", ...thumb, asm_cpu: "rea-no-such-cpu" },
      MSR_PRIMASK,
    );
    expect(unknown.lines).toEqual(["rea-no-such-cpu", "invalid"]);
  },
);

it.skipIf(rizin === undefined)(
  `states what a call with only base_address leaves unconfirmed (${banner})`,
  async () => {
    const { lines } = await runRizin(
      { command: "omlj; om-*; omlj", base_address: "0x8000" },
      CORTEX_M_IMAGE,
    );
    expect(mapsOf(lines[0])).toEqual([
      expect.objectContaining({ delta: 0, from: 0x8000 }),
    ]);
    // The command removed the map, so the map is not a fact of the result.
    expect(mapsOf(lines[1])).toEqual([]);
  },
);

it.skipIf(rizin === undefined)(
  `reads the file at base_address when a Rizin loader would claim it (${banner})`,
  async () => {
    const base = 0x08000000;
    for (const image of [AVR_LIKE_IMAGE, BIOS_LIKE_IMAGE]) {
      const last = base + image.length - 1;
      const { lines } = await runRizin(
        {
          command: `e io.va; omlj; p8 1 @ ${hex(base - 1)}; p8 4 @ ${hex(base)}; p8 1 @ ${hex(last)}; p8 1 @ ${hex(last + 1)}`,
          asm_arch: "arm",
          asm_bits: 16,
          base_address: hex(base),
        },
        image,
      );
      expect(lines[0]).toBe("true");
      expect(mapsOf(lines[1])).toEqual([
        expect.objectContaining({ delta: 0, from: base }),
      ]);
      expect(lines.slice(2)).toEqual([
        "ff",
        image.subarray(0, 4).toString("hex"),
        image.subarray(-1).toString("hex"),
        "ff",
      ]);
    }
  },
);

it.skipIf(rizin === undefined)(
  `selects an arch that differs from the host default (${banner})`,
  async () => {
    const plain = await runRizin(
      { command: "e asm.arch; e asm.bits; omlj" },
      MOS_6502_IMAGE,
    );
    expect(plain.lines[0]).not.toBe("6502");
    expect(mapsOf(plain.lines[2])).toEqual([
      expect.objectContaining({ delta: 0, from: 0 }),
    ]);

    const selected = await runRizin(
      {
        command: "e asm.arch; e asm.bits; omlj; pi 2 @ 0x8000",
        asm_arch: "6502",
        asm_bits: 8,
        base_address: "0x8000",
      },
      MOS_6502_IMAGE,
    );
    expect(selected.lines.slice(0, 2)).toEqual(["6502", "8"]);
    expect(mapsOf(selected.lines[2])).toEqual([
      expect.objectContaining({ delta: 0, from: 0x8000 }),
    ]);
    expect(selected.lines.slice(3)).toEqual(["nop", "rts"]);
  },
);

it.skipIf(rizin === undefined)(
  `does not apply an arch or bits value that Rizin lacks (${banner})`,
  async () => {
    const plain = await runRizin({ command: "e asm.arch" }, MOS_6502_IMAGE);
    const unknown = await runRizin(
      {
        command: "e asm.arch; e asm.bits",
        asm_arch: "rea-no-such-arch",
        asm_bits: 16,
      },
      MOS_6502_IMAGE,
    );
    // Rizin exits 0, decodes with its default arch and names the value only
    // on stderr. Evidence carries the limitation for this case.
    expect(unknown.lines[0]).toBe(plain.lines[0]);
    expect(unknown.stderr).toContain("rea-no-such-arch");

    // ARM has no 8-bit mode. Rizin 0.9.1 keeps its default and reports the
    // value on stderr; Rizin 0.7.4 uses 16 without a message.
    const unsupported = await runRizin(
      { command: "e asm.bits", asm_arch: "arm", asm_bits: 8 },
      CORTEX_M_IMAGE,
    );
    expect(unsupported.lines[0]).not.toBe("8");
  },
);

it.skipIf(rizin === undefined)(
  `admits only the widths that Rizin's arch plugins declare (${banner})`,
  async () => {
    // Rizin applies a width that shares a bit with a declared one, so it
    // would decode this Thumb `bx lr` as ARM32 at 17 with no message. REA
    // rejects the width before it starts Rizin.
    const directory = await mkdtemp(join(tmpdir(), "rea-rizin-decoder-"));
    const { client } = await createProviderEnvironmentMcpHarness({
      directory,
      clientName: "real-rizin-decoder-widths",
      serverOptions: { environment: { REA_RIZIN_COMMAND: rizin! } },
    });
    const path = join(directory, "image.bin");
    await writeFile(path, THUMB_RETURNS);
    for (const asm_bits of [17, 48]) {
      const response = await client.callTool({
        name: "execute_rizin_command",
        arguments: {
          path,
          command: "e asm.bits; pi 2",
          asm_arch: "arm",
          asm_bits,
        },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response as CallToolResult).error).toMatchObject(
        {
          code: "invalid_request",
          details: {
            issues: [{ path: ["asm_bits"], reason: "invalid_value" }],
          },
        },
      );
    }

    // The declared ARM widths 16 and 32 are applied as given and change the
    // decoding.
    const decode = async (bits: 16 | 32) =>
      runRizin(
        {
          command: "e asm.bits; pi 2",
          asm_arch: "arm",
          asm_bits: bits,
          base_address: "0x0",
        },
        THUMB_RETURNS,
      );
    const thumb = await decode(16);
    expect(thumb.lines).toEqual(["16", "bx lr", "bx lr"]);
    expect(thumb.stderr).toBe("");
    const arm32 = await decode(32);
    expect(arm32.lines[0]).toBe("32");
    expect(arm32.lines.slice(1)).not.toEqual(["bx lr", "bx lr"]);
    expect(arm32.stderr).toBe("");

    // Every width that this Rizin's arch plugins declare is one REA admits,
    // so a build with another width fails here rather than losing it. La
    // prints a feature column, the widths and the plugin name: 0.9.1 has five
    // feature letters and one space (`adAeI 16 32 64   arm`), 0.7.4 four and
    // two (`adAe  16 32 64   arm`). Laj is not valid JSON in either version.
    const { lines: plugins } = await runRizin({ command: "La" }, THUMB_RETURNS);
    const declared = new Map(
      plugins.flatMap((line) => {
        const match = /^\S{4,5}\s+(\d+(?: \d+)*)\s{2,}(\S+)/u.exec(line);
        return match === null
          ? []
          : [[match[2]!, match[1]!.split(" ").map(Number)] as const];
      }),
    );
    // A La layout that this parser does not read fails here, not as an empty
    // list of widths.
    expect(
      declared.size,
      `parsed no arch plugins from La:\n${plugins.join("\n")}`,
    ).toBeGreaterThan(0);
    expect(declared.get("arm")).toEqual([16, 32, 64]);
    const admitted = new Set<number>(
      rizinInputSchema.shape.asm_bits.unwrap().values,
    );
    for (const [plugin, widths] of declared)
      for (const width of widths)
        expect(admitted.has(width), `${plugin} declares ${width}`).toBe(true);
  },
);

function findRizin(): string | undefined {
  try {
    const path = execFileSync("which", ["rizin"], { encoding: "utf8" }).trim();
    return path === "" ? undefined : path;
  } catch {
    return undefined;
  }
}

function versionBanner(binary: string): string {
  try {
    return (
      execFileSync(binary, ["-v"], { encoding: "utf8" }).split("\n")[0] ??
      "unknown Rizin"
    ).trim();
  } catch {
    return "unknown Rizin";
  }
}
