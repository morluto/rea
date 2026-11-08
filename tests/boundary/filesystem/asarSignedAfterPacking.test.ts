import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import {
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
} from "../../../src/artifacts/ArtifactReader.js";
import { scanReader } from "../../../src/artifacts/inventory/scanReader.js";

import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createSignedAfterPackingAsarAddon } from "../../fixtures/signedAfterPackingAsarAddon.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

it("classifies an unpacked PE signed after packing without trusting the bytes", async () => {
  const { archive, addon, declaredSha256, observedSha256 } =
    await createSignedAfterPackingAsarAddon();

  const rejected = await analyzeJavaScriptApplication({ input_path: archive });
  if (rejected.ok) throw new Error("Expected strict integrity failure");
  expect(projectAnalysisError(rejected.error)).toMatchObject({
    code: "artifact_integrity_mismatch",
    details: {
      logical_path: addon,
      declared_sha256: declaredSha256,
      calculated_sha256: observedSha256,
      unpacked: true,
      signing_explanation: {
        kind: "signed-after-packing",
        platform: "pe-authenticode",
        unsigned_sha256: declaredSha256,
        signer_subjects: [expect.stringContaining("commonName=REA Fixture")],
        signer_subjects_complete: true,
      },
    },
  });

  const continued = await analyzeJavaScriptApplication({
    input_path: archive,
    integrity_policy: "record-and-continue",
  });
  if (!continued.ok) throw new Error("Expected explicit continuation");
  const result = javascriptApplicationAnalysisResultSchema.parse(
    continued.value.normalized_result,
  );
  const contradiction = result.integrity_contradictions.find(
    ({ logical_path }) => logical_path === addon,
  );
  expect(contradiction).toMatchObject({
    logical_path: addon,
    declared_sha256: declaredSha256,
    observed_sha256: observedSha256,
    trust: "observed-untrusted",
    signing_explanation: {
      kind: "signed-after-packing",
      platform: "pe-authenticode",
      unsigned_sha256: declaredSha256,
    },
  });
  expect(contradiction?.limitations[0]).toContain("signed-after-packing");
  expect(result.limitations).toEqual(
    expect.arrayContaining([expect.stringContaining(addon)]),
  );
});

it("keeps an ordinary unpacked mismatch unexplained", async () => {
  const { archive, addon } = await createStrippedAsarAddon();
  const continued = await analyzeJavaScriptApplication({
    input_path: archive,
    integrity_policy: "record-and-continue",
  });
  if (!continued.ok) throw new Error("Expected explicit continuation");
  const result = javascriptApplicationAnalysisResultSchema.parse(
    continued.value.normalized_result,
  );
  const contradiction = result.integrity_contradictions.find(
    ({ logical_path }) => logical_path === addon,
  );
  expect(contradiction).toMatchObject({
    logical_path: addon,
    trust: "observed-untrusted",
  });
  expect(contradiction).not.toHaveProperty("signing_explanation");
});

it("does not attach signing facts from a different same-sized second read", async () => {
  const { archive, addon, signed } = await createSignedAfterPackingAsarAddon();
  const first = Buffer.from(signed);
  first[0x100] = (first[0x100] ?? 0) ^ 1;
  const reader = new AsarArtifactReader(archive);
  const open = reader.open.bind(reader);
  let reads = 0;
  vi.spyOn(reader, "open").mockImplementation(async (entry, signal) => {
    if (entry.path !== addon) return open(entry, signal);
    reads += 1;
    return Readable.from([reads === 1 ? first : signed]);
  });
  try {
    const result = await scanReader(
      reader,
      [],
      undefined,
      "record-and-continue",
    );
    const mismatch = result.pendingContradictions.find(
      ({ occurrence }) => occurrence.logical_path === addon,
    );
    expect(reads).toBe(2);
    expect(mismatch?.integrity).toMatchObject({
      observed_sha256: createHash("sha256").update(first).digest("hex"),
    });
    expect(mismatch?.signingExplanation).toBeUndefined();
  } finally {
    await reader.close();
  }
});

it.each(["fail", "record-and-continue"] as const)(
  "retains the first mismatch under %s when the explanation read is unavailable",
  async (policy) => {
    const { archive, addon, observedSha256 } =
      await createSignedAfterPackingAsarAddon();
    const reader = new AsarArtifactReader(archive);
    const open = reader.open.bind(reader);
    let reads = 0;
    vi.spyOn(reader, "open").mockImplementation(async (entry, signal) => {
      if (entry.path === addon && ++reads === 2)
        throw new ArtifactEntryContentUnavailable(
          "gone",
          "companion unavailable",
        );
      return open(entry, signal);
    });
    try {
      if (policy === "fail")
        await expect(
          scanReader(reader, [], undefined, policy),
        ).rejects.toMatchObject({
          reason: "integrity",
          cause: { limitation: "companion unavailable" },
        });
      else {
        const result = await scanReader(reader, [], undefined, policy);
        expect(result.pendingContradictions).toHaveLength(1);
        expect(result.pendingContradictions[0]?.integrity).toMatchObject({
          observed_sha256: observedSha256,
        });
        expect(
          result.occurrences.find(({ logical_path }) => logical_path === addon)
            ?.limitations,
        ).toContain("Signing explanation unavailable: companion unavailable");
        expect(
          result.pendingContradictions[0]?.signingExplanation,
        ).toBeUndefined();
      }
    } finally {
      await reader.close();
    }
  },
);

it("retains cleanup failure when cancellation arrives during the optional second read", async () => {
  const { archive, addon } = await createSignedAfterPackingAsarAddon();
  const reader = new AsarArtifactReader(archive);
  const open = reader.open.bind(reader);
  const controller = new AbortController();
  const reason = new Error("stop during explanation");
  let reads = 0;
  vi.spyOn(reader, "open").mockImplementation(async (entry, signal) => {
    if (entry.path === addon && ++reads === 2) {
      controller.abort(reason);
      throw ArtifactReaderFailure.withCleanup(
        new ArtifactEntryContentUnavailable("gone", "companion unavailable"),
        { reason: "close failed", resources: ["companion handle"] },
      );
    }
    return open(entry, signal);
  });
  try {
    await expect(
      scanReader(reader, [], controller.signal, "record-and-continue"),
    ).rejects.toMatchObject({
      reason: "cancelled",
      cancellation: { reason },
      cleanup: { reason: "close failed", resources: ["companion handle"] },
    });
  } finally {
    await reader.close();
  }
});

it("retains the first mismatch when the optional read encounters an I/O failure", async () => {
  const { archive, addon, observedSha256 } =
    await createSignedAfterPackingAsarAddon();
  const reader = new AsarArtifactReader(archive);
  const open = reader.open.bind(reader);
  let reads = 0;
  vi.spyOn(reader, "open").mockImplementation(async (entry, signal) => {
    if (entry.path === addon && ++reads === 2)
      throw new ArtifactReaderFailure("io", "companion read failed");
    return open(entry, signal);
  });
  try {
    const result = await scanReader(
      reader,
      [],
      undefined,
      "record-and-continue",
    );
    expect(result.pendingContradictions[0]?.integrity).toMatchObject({
      observed_sha256: observedSha256,
    });
    expect(
      result.occurrences.find(({ logical_path }) => logical_path === addon)
        ?.limitations,
    ).toContain("Signing explanation unavailable: companion read failed");
  } finally {
    await reader.close();
  }
});
