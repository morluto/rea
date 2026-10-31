import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { WindowsMinidumpService } from "./WindowsMinidumpService.js";
import { WINDOWS_MINIDUMP_PROVIDER } from "../../domain/investigationProviders.js";
import { inspectWindowsMinidumpInputSchema } from "../../domain/native/windowsMinidump.js";
import { parseWindowsMinidump } from "../../native/minidump/WindowsMinidumpParser.js";
import { windowsMinidumpFixture } from "../../native/minidump/WindowsMinidump.fixture.js";
import { ok } from "../../domain/result.js";

const PATH = "/fixtures/recorded.dmp";
const observedReport = () => {
  const { bytes } = windowsMinidumpFixture();
  return parseWindowsMinidump(
    bytes,
    {
      path: PATH,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectWindowsMinidumpInputSchema.parse({ path: PATH }),
  );
};
const serviceReturning = (report: unknown, onInspect?: () => void) =>
  new WindowsMinidumpService({
    identity: WINDOWS_MINIDUMP_PROVIDER,
    inspect: () => {
      onInspect?.();
      return Promise.resolve(ok(report as never));
    },
  });

it("publishes observed Evidence with the recorded architecture", async () => {
  const result = await serviceReturning(await observedReport()).inspect({
    path: PATH,
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    operation: "inspect_windows_minidump",
    confidence: "observed",
  });
  expect(JSON.stringify(result.value)).toContain('"x86_64"');
});

it.each([
  "different-path",
  "outside-range",
  "wrong-coverage",
  "stream-count",
  "exception-register-outside",
])(
  "rejects invalid provider output before creating Evidence: %s",
  async (problem) => {
    const report = await observedReport();
    if (problem === "different-path") report.artifact.path = "/other.dmp";
    if (problem === "outside-range")
      report.memory[0]!.location.offset = report.artifact.bytes;
    if (problem === "wrong-coverage") report.coverage.unknown_streams = 9;
    if (problem === "stream-count") report.header.stream_count = 99;
    if (problem === "exception-register-outside")
      report.exception!.context.registers![0]!.location.offset =
        report.artifact.bytes;
    expect(
      await serviceReturning(report).inspect({ path: PATH }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  },
);

it("rejects relative paths and discards results after cancellation", async () => {
  const report = await observedReport();
  expect(
    await serviceReturning(report).inspect({ path: "relative.dmp" }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  const controller = new AbortController();
  expect(
    await serviceReturning(report, () => controller.abort()).inspect(
      { path: PATH },
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});
