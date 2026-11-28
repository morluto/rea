import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessMemoryAdmission,
  parseMemorySizeBytes,
  readHostAvailableBytes,
  readHostMemoryAdmissionFacts,
  type HostMemoryAdmissionFacts,
} from "./HostMemoryAdmission.js";

const GiB = 1024 ** 3;

describe("parseMemorySizeBytes", () => {
  it("parses common units and falls back to the default", () => {
    expect(parseMemorySizeBytes("2G")).toBe(2 * GiB);
    expect(parseMemorySizeBytes("2048M")).toBe(2 * GiB);
    expect(parseMemorySizeBytes("512k")).toBe(512 * 1024);
    expect(parseMemorySizeBytes(undefined)).toBe(2 * GiB);
  });
});

describe("assessMemoryAdmission", () => {
  it("admits when host and an unlimited cgroup fit the heap", () => {
    expect(
      assessMemoryAdmission(
        {
          hostAvailableBytes: 8 * GiB,
          cgroupMaxBytes: null,
          cgroupUsageBytes: null,
        },
        2 * GiB,
      ).admitted,
    ).toBe(true);
  });

  it("refuses when the effective cgroup remaining cannot fit heap plus headroom", () => {
    const result = assessMemoryAdmission(
      {
        hostAvailableBytes: 16 * GiB,
        cgroupMaxBytes: 1 * GiB,
        cgroupUsageBytes: 512 * 1024 ** 2,
      },
      600 * 1024 ** 2,
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.reason).toContain("cgroup remaining");
  });

  it("refuses when host availability cannot fit the heap", () => {
    const result = assessMemoryAdmission(
      {
        hostAvailableBytes: 1 * GiB,
        cgroupMaxBytes: null,
        cgroupUsageBytes: null,
      },
      2 * GiB,
    );
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toContain("cgroup remaining unlimited");
      expect(result.reason).toContain("Ghidra launch refused by memory guard");
    }
  });

  it("respects custom minHeadroomBytes", () => {
    // 2 GiB heap + 100 MiB custom headroom = 2148 MiB needed. 2100 MiB available -> refused.
    const refused = assessMemoryAdmission(
      {
        hostAvailableBytes: 2100 * 1024 ** 2,
        cgroupMaxBytes: null,
        cgroupUsageBytes: null,
      },
      2 * GiB,
      { minHeadroomBytes: 100 * 1024 ** 2 },
    );
    expect(refused.admitted).toBe(false);

    // 2 GiB heap + 50 MiB custom headroom = 2098 MiB needed. 2100 MiB available -> admitted.
    const admitted = assessMemoryAdmission(
      {
        hostAvailableBytes: 2100 * 1024 ** 2,
        cgroupMaxBytes: null,
        cgroupUsageBytes: null,
      },
      2 * GiB,
      { minHeadroomBytes: 50 * 1024 ** 2 },
    );
    expect(admitted.admitted).toBe(true);
  });

  it("uses cgroupRemainingBytes to reflect parent limits under sibling memory pressure", () => {
    // Parent limit 4 GiB, leaf usage 256 MiB, but siblings use 3 GiB, so cgroupRemainingBytes is 1 GiB.
    const facts: HostMemoryAdmissionFacts = {
      hostAvailableBytes: 16 * GiB,
      cgroupMaxBytes: 4 * GiB,
      cgroupUsageBytes: 256 * 1024 ** 2,
      cgroupRemainingBytes: 1 * GiB,
    };
    // 2 GiB heap + 512 MiB headroom = 2.5 GiB needed.
    // Without cgroupRemainingBytes, 4 GiB - 256 MiB = 3.75 GiB would wrongly admit.
    // With cgroupRemainingBytes (1 GiB), it correctly refuses.
    const result = assessMemoryAdmission(facts, 2 * GiB);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toContain("1024 MiB available");
      expect(result.reason).toContain("cgroup remaining 1024 MiB");
    }
  });

  it("bounds remaining allowance by cgroupMaxBytes even if cgroupRemainingBytes is larger", () => {
    const facts: HostMemoryAdmissionFacts = {
      hostAvailableBytes: 16 * GiB,
      cgroupMaxBytes: 1 * GiB,
      cgroupUsageBytes: null,
      cgroupRemainingBytes: 6 * GiB,
    };
    // 2 GiB heap + 512 MiB headroom = 2.5 GiB needed.
    // Cgroup max is 1 GiB, so remaining can never exceed 1 GiB.
    const result = assessMemoryAdmission(facts, 2 * GiB);
    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.reason).toContain("1024 MiB available");
    }
  });
});

describe("readHostAvailableBytes", () => {
  it("prefers MemAvailable from /proc/meminfo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-admission-"));
    try {
      const meminfo = join(dir, "meminfo");
      await writeFile(
        meminfo,
        "MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\nMemFree: 100 kB\n",
      );
      expect(
        await readHostAvailableBytes({
          platform: "linux",
          meminfoPath: meminfo,
        }),
      ).toBe(2_000_000 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to MemFree + Buffers + Cached when MemAvailable is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-admission-fallback-"));
    try {
      const meminfo = join(dir, "meminfo");
      await writeFile(
        meminfo,
        "MemTotal: 8000000 kB\nMemFree: 500000 kB\nBuffers: 100000 kB\nCached: 400000 kB\n",
      );
      expect(
        await readHostAvailableBytes({
          platform: "linux",
          meminfoPath: meminfo,
        }),
      ).toBe(1_000_000 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readHostMemoryAdmissionFacts", () => {
  it("combines host availability with injected cgroup facts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-admission-"));
    try {
      const meminfo = join(dir, "meminfo");
      await writeFile(meminfo, "MemAvailable: 4000000 kB\n");
      const facts = await readHostMemoryAdmissionFacts({
        platform: "linux",
        meminfoPath: meminfo,
        readCgroup: async () => ({
          effectiveMemoryMax: 2 * GiB,
          usageBytes: 512 * 1024 ** 2,
          effectiveRemainingBytes: 1536 * 1024 ** 2,
        }),
      });
      expect(facts.hostAvailableBytes).toBe(4_000_000 * 1024);
      expect(facts.cgroupMaxBytes).toBe(2 * GiB);
      expect(facts.cgroupUsageBytes).toBe(512 * 1024 ** 2);
      expect(facts.cgroupRemainingBytes).toBe(1536 * 1024 ** 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
