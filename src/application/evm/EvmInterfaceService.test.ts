import { expect, it } from "vitest";
import { EvmInterfaceService } from "./EvmInterfaceService.js";
import {
  evmInterfaceExecution,
  evmInterfaceFixture,
} from "../../../tests/fixtures/evm/interface.js";
import { err, ok } from "../../domain/result.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";

it.each([
  { path: "relative.hex", encoding: "hex" },
  { path: "/selected", encoding: "auto" },
  { path: "/selected" },
  { path: "/selected", encoding: "raw", approval: true },
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
      inspect: () => Promise.resolve(ok(execution)),
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
  expect(
    await cancelled.inspect(
      { path: "/artifacts/source-owned.hex", encoding: "hex" },
      { signal: controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      capturedOutput: observed.diagnostics,
    },
  });
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
