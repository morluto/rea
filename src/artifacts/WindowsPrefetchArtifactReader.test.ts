import { expect, it } from "vitest";

import { WindowsPrefetchArtifactReader } from "./WindowsPrefetchArtifactReader.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { prefetchFixture, writePrefetch } from "./windows/Prefetch.fixture.js";

const PARSED_VERSIONS = ["17", "23"] as const;

const readerFor = async (
  bytes: Buffer,
): Promise<WindowsPrefetchArtifactReader> =>
  new WindowsPrefetchArtifactReader(
    await writePrefetch("GOOGLE.EXE-1.pf", bytes),
  );

const inventory = async (
  reader: WindowsPrefetchArtifactReader,
): Promise<string[]> => {
  const limitations: string[] = [];
  for await (const _entry of reader.entries(undefined, {
    onCoverage: (coverage) => {
      limitations.push(...coverage.limitations);
    },
  }))
    continue;
  return limitations;
};

it.each(PARSED_VERSIONS)(
  "reports the v%s header without enumerating members",
  async (version) => {
    const reader = await readerFor(prefetchFixture({ version }));
    try {
      expect((await inventory(reader)).length).toBeGreaterThan(0);
      expect(reader.formatMetadata()).toMatchObject({
        kind: "windows-prefetch",
        version,
        file_bytes: prefetchFixture({ version }).length,
        executable_name: "GOOGLE.EXE",
        executable_path_hash: "1a2b3c4d",
      });
    } finally {
      await reader.close();
    }
  },
);

it("reports the v23 run count and last-run presence as declared", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", runCount: 12, runTimeSlots: 1 }),
  );
  try {
    await inventory(reader);
    expect(reader.formatMetadata()).toMatchObject({
      run_count: 12,
      run_time_slots: 1,
    });
  } finally {
    await reader.close();
  }
});

it("reports the v17 run count from the same field", async () => {
  const reader = await readerFor(prefetchFixture({ version: "17" }));
  try {
    await inventory(reader);
    expect(reader.formatMetadata()).toMatchObject({
      run_count: 7,
      run_time_slots: 1,
    });
  } finally {
    await reader.close();
  }
});

it("names the undecoded fields in its one limitation", async () => {
  const limitations = await inventory(
    await readerFor(prefetchFixture({ version: "23" })),
  );
  expect(limitations.join(" ")).toContain("not decoded");
});

it("identifies a Windows 8+ generation it does not parse", async () => {
  const reader = await readerFor(prefetchFixture({ version: "26" }));
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("v26") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("refuses a MAM container without calling it corrupt", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", compressed: true }),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("MAM") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it.each([
  ["17", 0x78],
  ["23", 0x80],
] as const)(
  "keeps the last-run timestamp unknown when a v%s capture ends before 0x%i",
  async (version, offset) => {
    // The file-information block is reached, but the generation's own FILETIME
    // is not, so presence cannot be claimed from the metrics array alone.
    const reader = await readerFor(
      prefetchFixture({ version }).subarray(0, offset + 4),
    );
    try {
      await inventory(reader);
      expect(reader.formatMetadata()).toMatchObject({ run_time_slots: null });
    } finally {
      await reader.close();
    }
  },
);

it("reports a truncated header as a format failure", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23" }).subarray(0, 40),
  );
  try {
    await expect(inventory(reader)).rejects.toBeInstanceOf(
      ArtifactReaderFailure,
    );
  } finally {
    await reader.close();
  }
});

it("does not claim bytes that lack a Prefetch signature", async () => {
  const bytes = Buffer.alloc(128, 0x41);
  bytes.write("MZ", 0);
  const reader = await readerFor(bytes);
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      message: expect.stringContaining("No Prefetch generation") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("inventories a .pf file as windows-prefetch end to end", async () => {
  const path = await writePrefetch(
    "GOOGLE.EXE-1A2B3C4D.pf",
    prefetchFixture({ version: "23" }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("windows-prefetch");
  expect(snapshot.coverage).toMatchObject({
    scope: "container-entries",
    status: "complete",
  });
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({
    artifact_kind: "container",
    artifact_format: "windows-prefetch",
    format_metadata: {
      kind: "windows-prefetch",
      executable_name: "GOOGLE.EXE",
      run_count: 7,
    },
  });
  expect(
    snapshot.limitations.some((limitation) =>
      limitation.startsWith("Windows Prefetch inventory"),
    ),
  ).toBe(true);
});
