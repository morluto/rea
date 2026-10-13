import { expect, it } from "vitest";
import { createEvidence } from "../../domain/evidence.js";
import { wasmInterfaceComparisonSchema } from "../../contracts/wasm/wasmComparisonContracts.js";
import { compareWasmInterfaces } from "./WasmInterfaceComparisonService.js";
import type { WasmInterface } from "../../domain/wasm/wasmInterface.js";
import { wasmArtifactFixture } from "../../../tests/fixtures/wasm/artifact.js";

const facts = (
  name: string,
  parameter: "i32" | "i64" = "i32",
): WasmInterface => ({
  state: "complete",
  issues: [],
  entries: [
    {
      direction: "export",
      module: null,
      name,
      kind: "func",
      index: 0,
      signature: { kind: "func", params: [parameter], results: [] },
      wat_form: `(export "${name}" (func 0))`,
      issue: null,
    },
  ],
});
const evidence = (interfaceFacts?: WasmInterface) => {
  const report = wasmArtifactFixture();
  if (interfaceFacts !== undefined) report.interface = interfaceFacts;
  return createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "file",
    },
    { id: "fixture", name: "typed fixture", version: "1" },
    {
      operation: "inspect_wasm_artifact",
      parameters: { path: report.artifact.path },
      result: report,
      confidence: "observed",
    },
  );
};
const compare = async (
  left: ReturnType<typeof evidence>,
  right: ReturnType<typeof evidence>,
) => {
  const result = await compareWasmInterfaces({ left, right, scope: "both" });
  if (!result.ok) throw result.error;
  return wasmInterfaceComparisonSchema.parse(result.value.normalized_result);
};

it("reports all five comparison states, including duplicate ambiguity and explicit selected scope", async () => {
  const left = facts("changed");
  const right = facts("changed", "i64");
  left.entries.push(
    ...facts("unchanged").entries,
    ...facts("removed").entries,
    ...facts("dup").entries,
    ...facts("dup").entries,
  );
  right.entries.push(
    ...facts("unchanged").entries,
    ...facts("added").entries,
    ...facts("dup").entries,
  );
  const report = await compare(evidence(left), evidence(right));
  expect(report.summary).toEqual({
    changed: 1,
    unchanged: 1,
    removed: 1,
    added: 1,
    unknown: 1,
  });
  expect(report.changes.find((c) => c.name === "dup")).toMatchObject({
    state: "unknown",
    left: [expect.anything(), expect.anything()],
    right: [expect.anything()],
  });
  const selected = await compareWasmInterfaces({
    left: evidence(left),
    right: evidence(right),
    scope: "imports",
  });
  if (!selected.ok) throw selected.error;
  expect(selected.value.normalized_result).toMatchObject({
    changes: [],
    coverage: "complete-within-inputs",
  });
});

it("withholds absence claims for historical or partial inventories and unsupported signatures", async () => {
  const known = facts("f");
  const absent = await compare(evidence(), evidence(known));
  expect(absent).toMatchObject({
    coverage: "partial",
    changes: [{ state: "unknown" }],
  });
  const partial: WasmInterface = {
    state: "partial",
    issues: ["unread import table"],
    entries: [],
  };
  expect(await compare(evidence(partial), evidence(known))).toMatchObject({
    changes: [{ state: "unknown" }],
  });
  const unsupported = facts("f");
  unsupported.entries[0]!.signature = null;
  expect(await compare(evidence(known), evidence(unsupported))).toMatchObject({
    changes: [{ state: "unknown" }],
  });
  const partialMatch = facts("f");
  partialMatch.state = "partial";
  partialMatch.issues = ["Later imports were not examined"];
  expect(await compare(evidence(partialMatch), evidence(known))).toMatchObject({
    changes: [{ state: "unknown" }],
  });
  expect(await compare(evidence(), evidence())).toMatchObject({
    coverage: "unknown",
    changes: [],
  });
});

it("authenticates semantic Evidence and binds display subject and selection identity", async () => {
  const left = JSON.parse(JSON.stringify(evidence(facts("f"))));
  left.normalized_result.interface.entries[0].name = "tampered";
  expect(
    await compareWasmInterfaces({
      left,
      right: evidence(facts("f")),
      scope: "both",
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  const rebound = JSON.parse(JSON.stringify(evidence(facts("f"))));
  rebound.subject.local_path = "/other.wasm";
  expect(
    await compareWasmInterfaces({
      left: rebound,
      right: evidence(facts("f")),
      scope: "both",
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("resolves exact retained references and permits cancellation between comparison batches", async () => {
  const left = evidence(facts("f"));
  const right = evidence(facts("f", "i64"));
  const references = {
    left: { kind: "retained-evidence", evidence_id: left.evidence_id },
    right: { kind: "retained-evidence", evidence_id: right.evidence_id },
    scope: "both",
  };
  expect(await compareWasmInterfaces(references)).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
  const result = await compareWasmInterfaces(references, {}, (id) =>
    id === left.evidence_id ? left : right,
  );
  if (!result.ok) throw result.error;
  expect(result.value.evidence_links).toEqual([
    left.evidence_id,
    right.evidence_id,
  ]);
  const large = facts("f");
  large.entries.push(
    ...Array.from({ length: 2000 }, (_, i) => facts(`f${i}`).entries[0]!),
  );
  const controller = new AbortController();
  const pending = compareWasmInterfaces(
    { left: evidence(large), right: evidence(large), scope: "both" },
    { signal: controller.signal },
  );
  setImmediate(() => controller.abort());
  expect(await pending).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it.each([false, true])(
  "keeps a one-sided unsupported interface unknown with reverse=%s",
  async (reverse) => {
    const empty: WasmInterface = { state: "complete", issues: [], entries: [] };
    const unsupported = facts("exception");
    unsupported.entries[0]!.signature = null;
    unsupported.entries[0]!.issue = "Unsupported exnref global type";
    const sides = reverse ? [unsupported, empty] : [empty, unsupported];
    expect(await compare(evidence(sides[0]), evidence(sides[1]))).toMatchObject(
      {
        coverage: "partial",
        summary: { added: 0, removed: 0, unknown: 1 },
        changes: [{ state: "unknown" }],
      },
    );
  },
);
