import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessMemoryAdmission,
  parseMemorySizeBytes,
  readHostAvailableBytes,
  readHostMemoryAdmissionFacts,
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
    expect(
      assessMemoryAdmission(
        {
          hostAvailableBytes: 1 * GiB,
          cgroupMaxBytes: null,
          cgroupUsageBytes: null,
        },
        2 * GiB,
      ).admitted,
    ).toBe(false);
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
        }),
      });
      expect(facts.hostAvailableBytes).toBe(4_000_000 * 1024);
      expect(facts.cgroupMaxBytes).toBe(2 * GiB);
      expect(facts.cgroupUsageBytes).toBe(512 * 1024 ** 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
