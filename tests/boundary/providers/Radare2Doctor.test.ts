import { describe, expect, it } from "vitest";

import {
  inspectRadare2Provider,
  parseRadare2Version,
} from "../../../src/radare2/Radare2Doctor.js";

const versionOutput = "radare2 6.2.4 +0 abi:152 @ darwin-arm_64\n";

describe("parseRadare2Version", () => {
  it("extracts the semantic version from `radare2 -version` output", () => {
    expect(parseRadare2Version(versionOutput)).toBe("6.2.4");
    expect(parseRadare2Version("radare2 5.9.1\n")).toBe("5.9.1");
  });

  it("returns null for unrecognized output", () => {
    expect(parseRadare2Version("not radare2")).toBeNull();
    expect(parseRadare2Version("")).toBeNull();
  });
});

describe("inspectRadare2Provider", () => {
  it("reports a healthy provider with an r2pipe2-capable version", async () => {
    const inspection = await inspectRadare2Provider(
      { REA_R2_COMMAND: "/selected/r2" },
      { runVersion: async () => ({ ok: true, stdout: versionOutput }) },
    );
    expect(inspection).toMatchObject({
      id: "radare2",
      configured: true,
      available: true,
      providerVersion: "6.2.4",
    });
    expect(inspection.checks).toEqual([]);
  });

  it("reports a missing executable as a missing dependency", async () => {
    const inspection = await inspectRadare2Provider(
      {},
      {
        runVersion: async () => ({
          ok: false as const,
          code: "ENOENT",
        }),
      },
    );
    expect(inspection.available).toBe(false);
    expect(inspection.providerVersion).toBeNull();
    expect(inspection.checks[0]).toMatchObject({
      name: "radare2-executable",
      ok: false,
      classification: "missing_dependency",
    });
  });

  it("flags a version below the r2pipe2 floor as config drift", async () => {
    const inspection = await inspectRadare2Provider(
      {},
      { runVersion: async () => ({ ok: true, stdout: "radare2 5.8.9\n" }) },
    );
    expect(inspection.available).toBe(true);
    expect(inspection.checks[0]).toMatchObject({
      name: "radare2-r2pipe2",
      ok: false,
      classification: "config_drift",
    });
  });
});
