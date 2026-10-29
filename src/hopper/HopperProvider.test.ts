import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import { silentLogger } from "../logger.js";
import { ok } from "../domain/result.js";
import { HopperClient } from "./HopperClient.js";
import { HopperProvider } from "./HopperProvider.js";

describe("Hopper provider capabilities", () => {
  it("declines caller-selected gamecube-dol targets before the ELF powerpc gate", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/game.dol",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "gamecube-dol",
        architecture: "powerpc",
        availableArchitectures: ["powerpc"],
        byteOrder: "big",
        bits: 32,
        entryPoint: "0x80003100",
        entryPointSource: "dol-header",
        dol: {
          sections: [],
          bss: { address: 0, size: 0 },
          bssOverlaps: [],
          bssGaps: [],
          entryPoint: 0x8000_3100,
        },
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("gamecube-dol"),
    });
  });
  it("declines headerless raw-binary targets with a Ghidra-directed reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/ecu.bin",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "raw-binary",
        architecture: "arm",
        availableArchitectures: ["arm"],
        entryPoint: "0x8000000",
        entryPointSource: "0x8000000",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("Ghidra"),
    });
  });
  it("declines DOS MZ targets with a provider-specific support reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/legacy.exe",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "dos-mz",
        architecture: "x86",
        availableArchitectures: ["x86"],
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("Ghidra"),
    });
  });
  it("declines Hexagon targets with a Ghidra-directed reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    const support = provider.inspectTargetSupport({
      path: "/tmp/chre_pal.so",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "hexagon",
      availableArchitectures: ["hexagon"],
    });
    expect(support).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringContaining("Hexagon"),
    });
    if (support.status === "unsupported") {
      expect(support.reason).toContain("Ghidra");
    }
  });
  it("declines thin arm64_32 Mach-O targets without a verified lane", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger, {});
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/watch.o",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "mach-o",
        architecture: "arm64_32",
        availableArchitectures: ["arm64_32"],
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringContaining("arm64_32"),
    });
  });
});

describe("Hopper relationship coverage", () => {
  it.each([
    ["procedure_callers", ["callers"]],
    ["procedure_callees", ["callees"]],
    ["analyze_function", ["callers", "callees"]],
  ] as const)(
    "retains %s observations without claiming exhaustive relationships",
    async (operation, directions) => {
      const config = parseConfig({});
      if (!config.ok) throw config.error;
      const source =
        operation === "analyze_function"
          ? {
              callers: [],
              callees: [{ address: "0x2000", name: "tail_target" }],
            }
          : operation === "procedure_callees"
            ? ["0x2000"]
            : [];
      const callTool = vi
        .spyOn(HopperClient.prototype, "callTool")
        .mockResolvedValue(ok(source));
      const client = new HopperProvider(
        config.value,
        silentLogger,
        {},
        "linux",
      ).createClient({
        path: "/tmp/fixture.hop",
        sha256: "a".repeat(64),
        kind: "database",
        format: "analysis-database",
      });
      try {
        const observed = await client.execute(operation, {
          procedure: "0x1000",
        });
        if (!observed.ok) throw observed.error;
        expect(observed.value.result).toEqual(source);
        expect(observed.value.relationshipCoverage).toMatchObject({
          status: "unknown",
          limited_directions: directions,
          reason: expect.stringContaining("resolved tail calls"),
        });
      } finally {
        await client.close();
        callTool.mockRestore();
      }
    },
  );
});
