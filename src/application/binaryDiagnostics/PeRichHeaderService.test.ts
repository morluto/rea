import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectPeRichHeaderInputSchema,
  type PeRichHeader,
} from "../../domain/native/peRichHeader.js";
import { PE_RICH_HEADER_PROVIDER } from "../../domain/investigationProviders.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ok } from "../../domain/result.js";
import { peRichHeaderImage } from "../../native/pe/PeRichHeader.fixture.js";
import { parsePeRichHeader } from "../../native/pe/PeRichHeaderParser.js";
import { PeRichHeaderService } from "./PeRichHeaderService.js";

const identity = PE_RICH_HEADER_PROVIDER;
const path = "/artifacts/app.exe";

const parsedReport = async (
  options: Parameters<typeof peRichHeaderImage>[0] = {},
): Promise<PeRichHeader> => {
  const bytes = peRichHeaderImage(options);
  return parsePeRichHeader(
    bytes,
    {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    inspectPeRichHeaderInputSchema.parse({ path }),
  );
};

const serviceFor = (report: PeRichHeader) =>
  new PeRichHeaderService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  });

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const report = await parsedReport();
  const service = new PeRichHeaderService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "app.exe" });
  const extra = await service.inspect({ path, extra: true });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("discards an observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const report = await parsedReport();
  const service = new PeRichHeaderService({
    identity,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect({ path }, { signal: controller.signal });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});

it("locates the whole record in observed Evidence", async () => {
  const report = await parsedReport();
  const result = await serviceFor(report).inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.subject).toMatchObject({
    format: "pe",
    architecture: "x86_64",
  });
  expect(result.value.locations).toContainEqual({
    kind: "file-offset-range",
    start: 0x80,
    end: 0xb0,
  });
});

it("reports no record when the PE header overlaps the DOS header", async () => {
  // e_lfanew 0x30 is a valid image that leaves no room for a Rich footer.
  const report = await parsedReport({ block: false, peOffset: 0x30 });
  expect(report).toMatchObject({
    pe_header_offset: 0x30,
    rich_header: { state: "absent" },
  });
  const result = await serviceFor(report).inspect({ path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(report);
});

it.each([
  ["absent", { block: false }, null],
  ["malformed", { omitStart: true }, { start: 0xa8, end: 0xb0 }],
] as const)(
  "locates an %s record by what was read",
  async (_label, options, range) => {
    const result = await serviceFor(await parsedReport(options)).inspect({
      path,
    });
    if (!result.ok) throw result.error;
    const ranges = result.value.locations.filter(
      (location) => location.kind === "file-offset-range",
    );
    expect(ranges).toEqual(
      range === null ? [] : [{ kind: "file-offset-range", ...range }],
    );
  },
);

it.each([
  [
    "a record outside the space before the PE header",
    (value: PeRichHeader) => {
      value.pe_header_offset = 0x90;
    },
  ],
  [
    "an entry count that disagrees with the record size",
    (value: PeRichHeader) => {
      if (value.rich_header.state === "present")
        value.rich_header.entries.pop();
    },
  ],
  [
    "a footer detached from its record",
    (value: PeRichHeader) => {
      if (value.rich_header.state === "present")
        value.rich_header.footer_location.offset -= 8;
    },
  ],
  [
    "a checksum verdict that contradicts its values",
    (value: PeRichHeader) => {
      if (value.rich_header.state === "present")
        value.rich_header.checksum.matches = false;
    },
  ],
  [
    "a PE header past the artifact",
    (value: PeRichHeader) => {
      value.pe_header_offset = value.artifact.bytes;
    },
  ],
] as const)(
  "rejects %s before creating observed Evidence",
  async (_label, mutate) => {
    const report = await parsedReport();
    mutate(report);
    const result = await serviceFor(report).inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  },
);
