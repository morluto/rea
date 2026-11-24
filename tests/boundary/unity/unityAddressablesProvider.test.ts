import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisMalformedTargetError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  UNITY_ADDRESSABLES_BUDGET_DEFAULTS,
  UNITY_ADDRESSABLES_BUDGET_MAXIMA,
} from "../../../src/domain/unity/unityAddressables.js";
import { UnityAddressablesProvider } from "../../../src/unity/UnityAddressablesProvider.js";
import {
  binaryCatalog,
  jsonCatalog,
  sampleCatalog,
} from "../../fixtures/unity/addressables.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** One-shot inspections keep the real reader's cleanup at one test boundary. */
const inspect = async (input: {
  path: string;
  hash_path?: string;
  max_input_bytes?: number;
  max_report_bytes?: number;
}) => {
  const provider = new UnityAddressablesProvider();
  try {
    return await provider.inspect(input);
  } finally {
    await provider.close();
  }
};

const write = async (name: string, bytes: Buffer | string) => {
  const directory = await createTestTempDirectory("rea-addressables-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

it.each([
  ["catalog.json", jsonCatalog()],
  ["catalog.bin", binaryCatalog(sampleCatalog(), { version: 3 })],
])(
  "reports %s with artifact identity and unchanged input bytes",
  async (name, bytes) => {
    const path = await write(name, bytes);
    const result = await inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(result.value.hash_file).toBeNull();
    expect(result.value.keys).toHaveLength(7);
    expect(result.value.locations).toHaveLength(5);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

it("records a selected catalog.hash and states that it is not recomputed", async () => {
  const path = await write("catalog.bin", binaryCatalog());
  const hashPath = join(path, "..", "catalog.hash");
  await writeFile(hashPath, "911a1ea20bb2c634df9e7052761a6bb2\n");
  const result = await inspect({ path, hash_path: hashPath });
  if (!result.ok) throw result.error;
  expect(result.value.hash_file).toMatchObject({
    artifact: { path: hashPath, bytes: 33 },
    text: "911a1ea20bb2c634df9e7052761a6bb2",
  });
  expect(result.value.limitations.join(" ")).toContain("not recomputed");
});

it("reports non-printable hash text as null instead of guessing", async () => {
  const path = await write("catalog.json", jsonCatalog());
  const hashPath = join(path, "..", "catalog.hash");
  await writeFile(hashPath, Buffer.from([0x00, 0xff, 0x41]));
  const result = await inspect({ path, hash_path: hashPath });
  if (!result.ok) throw result.error;
  expect(result.value.hash_file?.text).toBeNull();
});

it("keeps the decoded catalog as catalog Evidence on a missing hash file", async () => {
  const path = await write("catalog.json", jsonCatalog());
  const result = await inspect({
    path,
    hash_path: join(path, "..", "missing.hash"),
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  const partial = result.error.partialObservation as {
    operation: string;
    confidence: string;
    limitations: string[];
    normalized_result: Record<string, unknown>;
  };
  expect(partial).toMatchObject({
    operation: "inspect_unity_addressables",
    // JSON dependencies are derived through keys, as in a complete result.
    confidence: "derived",
    normalized_result: {
      artifact: { path },
      format: "json",
      hash_file: null,
      keys: expect.any(Array),
      locations: expect.any(Array),
    },
  });
  expect(partial.limitations.join(" ")).not.toContain(
    "their rows were not all decoded",
  );
  expect(partial.limitations.join(" ")).toContain("missing.hash");
});

it("keeps the decoded catalog when only the selected hash file exceeds the report budget", async () => {
  const path = await write("catalog.json", jsonCatalog());
  const catalogOnly = await inspect({ path });
  if (!catalogOnly.ok) throw catalogOnly.error;
  const hashPath = join(path, "..", "catalog.hash");
  const hash = "f".repeat(2000);
  await writeFile(hashPath, hash);
  // The catalog report fits; its hash text and limitation do not.
  const limit = Buffer.byteLength(JSON.stringify(catalogOnly.value)) + 100;
  const result = await inspect({
    path,
    hash_path: hashPath,
    max_report_bytes: limit,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.message).toContain("retained without it");
  const partial = parseEvidence(result.error.partialObservation);
  expect(partial).toMatchObject({
    operation: "inspect_unity_addressables",
    parameters: { path, hash_path: hashPath },
    normalized_result: {
      hash_file: null,
      keys: catalogOnly.value.keys,
      locations: catalogOnly.value.locations,
    },
  });
  const sha256 = createHash("sha256").update(hash).digest("hex");
  expect(partial.limitations.join(" ")).toContain(
    `${hashPath} (sha256 ${sha256}, 2000 bytes) was read`,
  );
});

it("keeps only bounded source facts when the decoded catalog exceeds the report budget", async () => {
  const path = await write(
    "catalog.json",
    jsonCatalog({ ...sampleCatalog(), locatorId: "L".repeat(20_000) }),
  );
  const result = await inspect({
    path,
    hash_path: join(path, "..", "missing.hash"),
    max_report_bytes: 8000,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The report refusal wins over the missing hash file, which is never read;
  // the unadmitted catalog is not kept.
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.message).not.toContain("missing.hash");
  const partial = result.error.partialObservation as {
    operation: string;
    normalized_result: Record<string, unknown>;
  };
  expect(partial.operation).toBe("observe_unity_addressables_source");
  expect(partial.normalized_result).not.toHaveProperty("keys");
  expect(JSON.stringify(partial)).not.toContain("L".repeat(20_000));
});

it.each([
  [
    binaryCatalog(sampleCatalog(), { version: 1 }),
    AnalysisUnsupportedTargetError,
  ],
  [Buffer.from("not a catalog"), AnalysisUnsupportedTargetError],
  [
    jsonCatalog(sampleCatalog(), {
      patch: (catalog) => delete catalog.m_ProviderIds,
    }),
    AnalysisMalformedTargetError,
  ],
])(
  "maps format failures to typed errors with source identity (%#)",
  async (bytes, type) => {
    const path = await write("catalog.bin", bytes);
    const result = await inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(type);
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: { artifact: { path, bytes: bytes.length } },
    });
  },
);

it("refuses a report over budget during decoding with admitted counts retained", async () => {
  const path = await write("catalog.bin", binaryCatalog());
  const result = await inspect({ path, max_report_bytes: 900 });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(result.error.partialObservation).toMatchObject({
    // Locations are admitted as they are found, so the refusal knows only a
    // lower bound and does not present it as the declared count.
    normalized_result: {
      discovered_row_counts: { keys: 7, locations_at_least: 4 },
    },
  });
  expect(
    (result.error.partialObservation as { normalized_result: object })
      .normalized_result,
  ).not.toHaveProperty("declared_row_counts");
});

it.each([
  ["max_input_bytes", (bytes: number) => bytes - 1],
  ["max_report_bytes", () => 900],
] as const)(
  "refuses at the per-call %s with its control and succeeds once it is raised",
  async (parameter, lowered) => {
    const bytes = binaryCatalog();
    const path = await write("catalog.bin", bytes);
    const refused = await inspect({ path, [parameter]: lowered(bytes.length) });
    if (refused.ok) throw new Error(`${parameter} must refuse`);
    expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
    const projected = projectAnalysisError(refused.error);
    expect(projected.retryable).toBe(false);
    expect(projected.details?.limit).toEqual({
      control_kind: "parameter",
      parameter,
      effective_value: lowered(bytes.length),
      unit: "bytes",
      minimum: 1,
      maximum: UNITY_ADDRESSABLES_BUDGET_MAXIMA[parameter],
      default_value: UNITY_ADDRESSABLES_BUDGET_DEFAULTS[parameter],
      applies_at: "next_call",
    });
    const raised = await inspect({ path, [parameter]: 64 * 1024 * 1024 });
    if (!raised.ok) throw raised.error;
    expect(raised.value.keys).toHaveLength(7);
  },
);

it("names the fixed catalog.hash allowance rather than a per-call control", async () => {
  const path = await write("catalog.json", jsonCatalog());
  const hashPath = join(path, "..", "catalog.hash");
  await writeFile(hashPath, "f".repeat(4097));
  const result = await inspect({ path, hash_path: hashPath });
  if (result.ok) throw new Error("An oversized catalog.hash must refuse");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw result.error;
  expect(result.error.fixedAllowance).toMatchObject({
    kind: "input",
    limit: 4096,
    unit: "bytes",
  });
  expect(projectAnalysisError(result.error).details?.limit).toBeUndefined();
});

/** More than one yield interval of keys. */
const largeCatalog = () => {
  const catalog = sampleCatalog();
  for (let index = 0; index < 600; index++)
    catalog.keys.push({
      key: { kind: "string", value: `k${index}` },
      locations: [0],
    });
  return catalog;
};

it("admits one inspection at a time and none after close", async () => {
  const path = await write("catalog.bin", binaryCatalog(largeCatalog()));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let acknowledge!: () => void;
  const yielded = new Promise<void>((resolve) => (acknowledge = resolve));
  const provider = new UnityAddressablesProvider(() => {
    acknowledge();
    return gate;
  });
  const first = provider.inspect({ path });
  try {
    await awaitAcknowledgement(yielded, first, "first decoding yield");
    const second = await provider.inspect({ path });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
      expect(second.error).toMatchObject({ retryable: true });
    }
    release();
    expect((await first).ok).toBe(true);
  } finally {
    release();
    await first.catch(() => undefined);
    await provider.close();
  }
  const closed = await provider.inspect({ path });
  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(closed.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
});

it("stops between decoding steps when cancelled", async () => {
  const path = await write("catalog.bin", binaryCatalog(largeCatalog()));
  const controller = new AbortController();
  const provider = new UnityAddressablesProvider(() => {
    controller.abort(new Error("stop"));
    return Promise.resolve();
  });
  try {
    const result = await provider.inspect(
      { path },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  } finally {
    await provider.close();
  }
});
