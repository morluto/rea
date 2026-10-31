import { expect, it } from "vitest";
import { EvmInterfaceService } from "./EvmInterfaceService.js";
import type { EvmInterfaceExecution } from "./EvmInterfacePort.js";
import {
  evmInterfaceExecution,
  evmInterfaceFixture,
} from "../../../tests/fixtures/evm/interface.js";
import { err, ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { selectSolcArtifact } from "../../domain/evm/solcArtifactSelection.js";

it.each([
  { path: "relative.hex", encoding: "hex" },
  { path: "/selected", encoding: "auto" },
  { path: "/selected" },
  { path: "/selected", encoding: "raw", approval: true },
  { path: "/selected", encoding: "hex", timeout_ms: 0 },
  { path: "/selected", encoding: "hex", timeout_ms: 2_147_483_648 },
])("rejects invalid selection before effects: %j", async (input) => {
  const service = new EvmInterfaceService({
    inspect: () => {
      throw new Error("must not start");
    },
  });
  expect(await service.inspect(input)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});
it.each(["carrier", "encoding", "digest", "no-subject"])(
  "rejects mismatched producer binding: %s",
  async (problem) => {
    const value = evmInterfaceFixture();
    if (problem === "carrier") value.artifact.path = "/other";
    if (problem === "encoding") value.artifact.encoding = "raw";
    const observed = evmInterfaceExecution(value);
    const execution = {
      ...observed,
      subject:
        problem === "no-subject"
          ? null
          : {
              path: "/artifacts/source-owned.hex",
              sha256:
                problem === "digest" ? "b".repeat(64) : value.artifact.sha256,
              format: "file" as const,
            },
    };
    const service = new EvmInterfaceService({
      inspect: () =>
        Promise.resolve(ok(execution as unknown as EvmInterfaceExecution)),
    });
    expect(
      await service.inspect({
        path: "/artifacts/source-owned.hex",
        encoding: "hex",
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError", capturedOutput: value.diagnostics },
    });
  },
);
it("preserves meaningful provider failure and cancellation before/after execution", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "evm",
    "inspect_evm_interface",
    "Selected limiter missing",
  );
  const service = new EvmInterfaceService({
    inspect: () => Promise.resolve(err(failure)),
  });
  expect(await service.inspect({ path: "/code", encoding: "raw" })).toEqual(
    err(failure),
  );
  const controller = new AbortController();
  const observed = evmInterfaceFixture();
  observed.diagnostics = {
    stdout: "selected\u0000",
    stderr: "warning",
    truncated: true,
  };
  const cancelled = new EvmInterfaceService({
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(evmInterfaceExecution(observed)));
    },
  });
  const late = await cancelled.inspect(
    { path: "/artifacts/source-owned.hex", encoding: "hex" },
    { signal: controller.signal },
  );
  expect(late).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      capturedOutput: observed.diagnostics,
      partialObservation: {
        operation: "inspect_evm_interface",
        normalized_result: observed,
      },
    },
  });
  if (!late.ok) {
    expect(late.error).toBeInstanceOf(AnalysisCancelledError);
    expect(parseEvidence(late.error.partialObservation)).toMatchObject({
      operation: "inspect_evm_interface",
      normalized_result: observed,
    });
  }
  const untouched = new EvmInterfaceService({
    inspect: () => {
      throw new Error("must not start");
    },
  });
  expect(
    await untouched.inspect(
      { path: "/code", encoding: "raw" },
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});

it("keeps malformed interface output ahead of a late cancellation", async () => {
  const controller = new AbortController();
  const malformed = evmInterfaceFixture();
  malformed.artifact.path = "/artifacts/other.hex";
  const result = await new EvmInterfaceService({
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(evmInterfaceExecution(malformed)));
    },
  }).inspect(
    { path: "/artifacts/source-owned.hex", encoding: "hex" },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it.each([false, true])(
  "retains compiler selection through late cancellation, rejecting mismatches first: %s",
  async (mismatched) => {
    const selection = {
      source_unit: "source.sol",
      contract_name: "C",
      bytecode_kind: "creation" as const,
    };
    const fixture = evmInterfaceFixture();
    const selected = selectSolcArtifact(
      new TextEncoder().encode(
        JSON.stringify({
          contracts: {
            "source.sol": {
              C: { evm: { bytecode: { object: fixture.bytecode.hex } } },
            },
          },
        }),
      ),
      selection,
    );
    if (!selected.ok) throw selected.error;
    const report = {
      ...fixture,
      artifact: { ...fixture.artifact, encoding: "solc-json" as const },
      bytecode: { ...fixture.bytecode, kind: "creation" as const },
      compiler_artifact: selected.value.artifact,
      inference_status: "examined" as const,
    };
    const controller = new AbortController();
    const result = await new EvmInterfaceService({
      inspect: () => {
        controller.abort("completed compiler inspection");
        return Promise.resolve(ok(evmInterfaceExecution(report)));
      },
    }).inspect(
      {
        path: fixture.artifact.path,
        encoding: {
          kind: "solc-json",
          ...selection,
          ...(mismatched ? { contract_name: "Other" } : {}),
        },
      },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected typed failure");
    if (mismatched) {
      expect(result.error).toBeInstanceOf(AnalysisOutputError);
    } else {
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(parseEvidence(result.error.partialObservation)).toMatchObject({
        parameters: { encoding: { kind: "solc-json", ...selection } },
        normalized_result: report,
      });
    }
  },
);

it("keeps an omitted timeout at the default and records a selected one", async () => {
  const value = evmInterfaceFixture();
  let seen: unknown;
  const service = new EvmInterfaceService({
    inspect: (input) => {
      seen = input;
      return Promise.resolve(ok(evmInterfaceExecution(value)));
    },
  });
  const omitted = await service.inspect({
    path: value.artifact.path,
    encoding: "hex",
  });
  expect(seen).toEqual({ path: value.artifact.path, encoding: "hex" });
  expect(omitted.ok).toBe(true);
  if (omitted.ok)
    expect(parseEvidence(omitted.value).parameters).not.toHaveProperty(
      "timeout_ms",
    );
  const selected = await service.inspect({
    path: value.artifact.path,
    encoding: "hex",
    timeout_ms: 45_000,
  });
  expect(seen).toEqual({
    path: value.artifact.path,
    encoding: "hex",
    timeout_ms: 45_000,
  });
  expect(selected.ok).toBe(true);
  if (selected.ok)
    expect(parseEvidence(selected.value).parameters).toMatchObject({
      timeout_ms: 45_000,
    });
});

it.each([null, "caller stopped", { requested: "stop" }])(
  "preserves the exact admission reason without invoking the provider: %j",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const service = new EvmInterfaceService({
      inspect: () => {
        throw new Error("must not start");
      },
    });
    const result = await service.inspect(
      { path: "/selected.hex", encoding: "hex" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
  },
);
