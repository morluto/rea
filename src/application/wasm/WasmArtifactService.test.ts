import { expect, it } from "vitest";
import { WasmArtifactService } from "./WasmArtifactService.js";
import {
  wasmArtifactFixture,
  wasmArtifactExecution,
} from "../../../tests/fixtures/wasm/artifact.js";
import { ok } from "../../domain/result.js";
it.each([
  { path: "relative" },
  { path: "/module", glue_paths: ["relative"] },
  { path: "/module", candidate_paths: ["relative"] },
  { path: "/module", fetch: true },
])("rejects invalid selection before effects: %j", async (input) => {
  const service = new WasmArtifactService({
    inspect: () => {
      throw new Error("Must not execute");
    },
  });
  expect(await service.inspect(input)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});
it.each(["path", "digest", "wat", "candidates", "glue"])(
  "rejects mismatched upstream observation: %s",
  async (problem) => {
    const value = wasmArtifactFixture();
    if (problem === "path") value.artifact.path = "/different";
    if (problem === "wat") value.wat.sha256 = "b".repeat(64);
    if (problem === "candidates") value.candidates = [];
    const execution = wasmArtifactExecution(value);
    const service = new WasmArtifactService({
      inspect: () =>
        Promise.resolve(
          ok({
            ...execution,
            subject: {
              path: "/artifacts/module.wasm",
              format: "file",
              sha256:
                problem === "digest" ? "b".repeat(64) : value.artifact.sha256,
            },
          }),
        ),
    });
    expect(
      await service.inspect({
        path: "/artifacts/module.wasm",
        ...(problem === "glue" ? { glue_paths: ["/glue.js"] } : {}),
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  },
);
it("cancels before provider work and delivers observed Evidence on success", async () => {
  const value = wasmArtifactFixture();
  let calls = 0;
  const service = new WasmArtifactService({
    inspect: () => {
      calls++;
      return Promise.resolve(ok(wasmArtifactExecution(value)));
    },
  });
  const controller = new AbortController();
  controller.abort();
  expect(
    await service.inspect(
      { path: value.artifact.path },
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  expect(calls).toBe(0);
  expect(await service.inspect({ path: value.artifact.path })).toMatchObject({
    ok: true,
    value: { confidence: "observed", normalized_result: value },
  });
});
