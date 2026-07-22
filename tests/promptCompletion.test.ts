import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import type { AnalysisClient } from "../src/application/AnalysisProvider.js";
import { BinarySession } from "../src/application/BinarySession.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../src/contracts/artifactComparisonExample.js";
import { PROCESS_CAPTURE_REFERENCE } from "../src/contracts/investigationExamples.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createPromptCompletionSource } from "../src/server/promptCompletion.js";
import { observed } from "./fixtures/analysisExecution.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("guided prompt completion", () => {
  it("reads live documents and paged procedures without ambiguous names", async () => {
    const requests: Array<Readonly<Record<string, unknown>>> = [];
    const session = new BinarySession(() => client(requests));
    directory = await createTestTempDirectory("rea-prompt-completion-");
    const target = join(directory, "fixture.hop");
    await writeFile(target, "fixture");
    expect((await session.open(target)).ok).toBe(true);
    const completion = createPromptCompletionSource(session, session);

    expect(await completion.complete("document", "app")).toEqual([
      "App",
      "AppTests",
    ]);
    expect(
      await completion.complete("procedure", "", {
        arguments: { document: "App" },
      }),
    ).toEqual(["0x1000", "0x2000", "0x3000", "0x4000", "tail", "unique"]);
    expect(requests).toEqual([
      { offset: 0, limit: 500, document: "App" },
      { offset: 2, limit: 500, document: "App" },
    ]);
    expect(await completion.complete("provider", "uni")).toEqual([
      "unidentified",
    ]);
    expect(await completion.complete("document", "x".repeat(4_097))).toEqual(
      [],
    );

    await session.close();
    expect(await completion.complete("document", "")).toEqual([]);
    expect(await completion.complete("procedure", "")).toEqual([]);
  });

  it("projects only validated typed identifiers from the evidence ledger", async () => {
    const session = new BinarySession(() => client([]));
    const invalidCapture = createEvidence(undefined, fixtureProvider, {
      operation: "capture_process_scenario",
      parameters: {},
      result: { schema_version: 4 },
      confidence: "observed",
      authority: "controlled-replay",
      environment: fixtureEnvironment,
    });
    const invalidInventory = createEvidence(undefined, fixtureProvider, {
      operation: "fixture_inventory",
      parameters: {},
      result: ARTIFACT_COMPARISON_EXAMPLE.right.normalized_result,
      confidence: "observed",
      authority: "shipped-artifact",
    });
    for (const evidence of [
      ARTIFACT_COMPARISON_EXAMPLE.left,
      PROCESS_CAPTURE_REFERENCE,
      invalidCapture,
      invalidInventory,
    ])
      expect(session.recordEvidence(evidence).ok).toBe(true);
    const unknown = session.recordUnknown({
      approved: true,
      question: "Which branch handles the fallback?",
      severity: "medium",
      domain: "control-flow",
      supporting_evidence_ids: [],
      contradicting_evidence_ids: [],
      required_authority: "analyst-inference",
      required_confidence: "derived",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    });
    if (!unknown.ok) throw unknown.error;
    const completion = createPromptCompletionSource(session, session);

    expect(await completion.complete("capture", "ev_")).toEqual([
      PROCESS_CAPTURE_REFERENCE.evidence_id,
    ]);
    expect(await completion.complete("manifest", "agm_")).toEqual([
      `agm_${"0".repeat(64)}`,
    ]);
    expect(await completion.complete("occurrence", "occ_")).toEqual([
      `occ_${"0".repeat(64)}`,
    ]);
    expect(await completion.complete("unknown", "unk_")).toEqual([
      unknown.value.unknown_id,
    ]);

    const resolved = session.updateUnknown({
      approved: true,
      unknown_id: unknown.value.unknown_id,
      expected_revision: unknown.value.revision,
      status: "resolved",
      severity: unknown.value.severity,
      supporting_evidence_ids: unknown.value.supporting_evidence_ids,
      contradicting_evidence_ids: unknown.value.contradicting_evidence_ids,
      required_authority: unknown.value.required_authority,
      required_confidence: unknown.value.required_confidence,
      required_environment: unknown.value.required_environment,
      recommended_probes: unknown.value.recommended_probes,
      relationships: unknown.value.relationships,
      resolution: {
        disposition: "withdrawn",
        rationale: "The requested fallback is outside the current scope.",
        evidence_ids: [],
      },
    });
    expect(resolved.ok).toBe(true);
    expect(await completion.complete("unknown", "")).toEqual([]);

    await session.close();
    expect(await completion.complete("evidence", "ev_")).toEqual([]);
  });

  it("deduplicates, case-folds, and returns deterministic live evidence IDs", async () => {
    const session = new BinarySession(() => client([]));
    for (let index = 149; index >= 0; index -= 1) {
      const evidence = createEvidence(undefined, fixtureProvider, {
        operation: `fixture-${String(index)}`,
        parameters: { index },
        result: index,
        confidence: "derived",
        authority: "analyst-inference",
      });
      expect(session.recordEvidence(evidence).ok).toBe(true);
      expect(session.recordEvidence(evidence).ok).toBe(true);
    }
    const completion = createPromptCompletionSource(session, session);
    const values = await completion.complete("evidence", "EV_");
    expect(values).toHaveLength(150);
    expect(values).toEqual([...values].sort());
  });

  it("does not offer procedure names from an incomplete discovery", async () => {
    let calls = 0;
    const completion = createPromptCompletionSource({
      execute() {
        calls += 1;
        return Promise.resolve(
          observed(
            calls === 1
              ? page(0, [{ address: "0x1000", value: "possibly_ambiguous" }], 1)
              : null,
          ),
        );
      },
    });
    expect(await completion.complete("procedure", "")).toEqual(["0x1000"]);
  });

  it("bounds procedure scans and rejects non-advancing continuation metadata", async () => {
    let calls = 0;
    const bounded = createPromptCompletionSource({
      execute(_operation, parameters) {
        calls += 1;
        const offset = Number(parameters.offset);
        const items = Array.from({ length: 500 }, (_, index) => {
          const address = offset + index;
          return {
            address: `0x${address.toString(16).padStart(8, "0")}`,
            value: `procedure_${String(address)}`,
          };
        });
        return Promise.resolve(
          observed({
            items,
            offset,
            limit: 500,
            total: 6_000,
            next_offset: offset + 500,
            has_more: true,
          }),
        );
      },
    });
    const values = await bounded.complete("procedure", "");
    expect(calls).toBe(10);
    expect(values).toHaveLength(5_000);
    expect(values.every((value) => value.startsWith("0x"))).toBe(true);

    let nonAdvancingCalls = 0;
    const nonAdvancing = createPromptCompletionSource({
      execute() {
        nonAdvancingCalls += 1;
        return Promise.resolve(
          observed(page(0, [{ address: "0x5000", value: "unsafe_name" }], 0)),
        );
      },
    });
    expect(await nonAdvancing.complete("procedure", "")).toEqual(["0x5000"]);
    expect(nonAdvancingCalls).toBe(1);
  });

  it("normalizes Unicode prefixes while preserving distinct exact identifiers", async () => {
    const completion = createPromptCompletionSource({
      execute(operation) {
        return Promise.resolve(
          observed(
            operation === "list_documents"
              ? ["Ａpp", "App", "app", "Zulu"]
              : null,
          ),
        );
      },
    });
    expect(await completion.complete("document", "ＡＰ")).toEqual([
      "App",
      "app",
      "Ａpp",
    ]);

    const malformed = createPromptCompletionSource({
      execute: () => Promise.resolve(observed(["valid", 1])),
    });
    expect(await malformed.complete("document", "")).toEqual([]);
  });
});

const fixtureProvider = { id: "fixture", name: "Fixture", version: "1" };
const fixtureEnvironment = {
  id: "fixture-linux",
  platform: "linux",
  architecture: "x86_64",
  isolation: "process" as const,
};

const client = (
  requests: Array<Readonly<Record<string, unknown>>>,
): AnalysisClient => ({
  execute(operation, parameters) {
    if (operation === "list_documents")
      return Promise.resolve(observed(["AppTests", "App", "App"]));
    if (operation === "list_procedures") {
      requests.push(parameters);
      const offset = parameters.offset;
      return Promise.resolve(
        observed(
          offset === 0
            ? page(
                0,
                [
                  { address: "0x1000", value: "duplicate" },
                  { address: "0x2000", value: "unique" },
                ],
                2,
              )
            : page(
                2,
                [
                  { address: "0x3000", value: "duplicate" },
                  { address: "0x4000", value: "tail" },
                ],
                null,
              ),
        ),
      );
    }
    return Promise.resolve(observed(null));
  },
  close: () => Promise.resolve(),
});

const page = (
  offset: number,
  items: readonly { readonly address: string; readonly value: string }[],
  nextOffset: number | null,
) => ({
  items,
  offset,
  limit: 500,
  total: 4,
  next_offset: nextOffset,
  has_more: nextOffset !== null,
});
