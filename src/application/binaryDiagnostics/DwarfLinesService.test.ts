import { describe, expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { DWARF_LINES_PROVIDER } from "../../domain/investigationProviders.js";
import type { DwarfLinesReport } from "../../domain/native/dwarfLines.js";
import { ok } from "../../domain/result.js";
import { DwarfLinesService } from "./DwarfLinesService.js";

const identity = DWARF_LINES_PROVIDER;
const report: DwarfLinesReport = {
  artifact: {
    path: "/artifacts/program",
    sha256: "a".repeat(64),
    bytes: 256,
  },
  format: "elf",
  bits: 64,
  byte_order: "little",
  machine: 62,
  architecture: "x86_64",
  sections: [
    {
      name: ".debug_line",
      role: ".debug_line",
      offset: 64,
      size: 64,
      compression: "none",
      uncompressed_size: 64,
    },
  ],
  debug_line: "present",
  omissions: [],
  selected_program_offset: null,
  programs: [],
  total_programs: 0,
  rows: [],
  total_rows: 0,
  address_matches: [],
  coverage: { status: "complete", reason: null },
  limitations: [
    "Directory names, file names, and line metadata are target-derived and untrusted.",
  ],
};

describe("DwarfLinesService", () => {
  it("rejects relative paths and unknown properties before reading", async () => {
    let calls = 0;
    const service = new DwarfLinesService({
      identity,
      inspect: () => {
        calls += 1;
        return Promise.resolve(ok(report));
      },
    });
    const rel = await service.inspect({ path: "program" });
    const extra = await service.inspect({
      path: report.artifact.path,
      extra: 1,
    });
    expect(rel.ok).toBe(false);
    expect(extra.ok).toBe(false);
    if (!rel.ok) expect(rel.error).toBeInstanceOf(AnalysisInputError);
    if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
    expect(calls).toBe(0);
  });

  it("emits Evidence with observed section locations and rejects mismatched provider bounds", async () => {
    const valid = await new DwarfLinesService({
      identity,
      inspect: () => Promise.resolve(ok(report)),
    }).inspect({ path: report.artifact.path });
    if (!valid.ok) throw valid.error;
    expect(valid.value).toMatchObject({
      confidence: "observed",
      subject: { identity: { format: "elf", architecture: "x86_64" } },
      locations: [
        { kind: "artifact-path", path: report.artifact.path },
        { kind: "file-offset-range", start: 64, end: 128 },
      ],
    });

    const wrongOffset = await new DwarfLinesService({
      identity,
      inspect: () => Promise.resolve(ok(report)),
    }).inspect({ path: report.artifact.path, program_offset: 0 });
    expect(wrongOffset.ok).toBe(false);
    if (!wrongOffset.ok)
      expect(wrongOffset.error).toBeInstanceOf(AnalysisOutputError);

    const wrongQueryOrder = await new DwarfLinesService({
      identity,
      inspect: () =>
        Promise.resolve(
          ok({
            ...report,
            address_matches: [
              { query_address: "0x2000", status: "not_found", matches: [] },
            ],
          }),
        ),
    }).inspect({ path: report.artifact.path, addresses: ["0x1000"] });
    expect(wrongQueryOrder.ok).toBe(false);
    if (!wrongQueryOrder.ok)
      expect(wrongQueryOrder.error).toBeInstanceOf(AnalysisOutputError);
  });

  it("accepts arm64e request answered by arm64 slice and retains partial observation on late cancel", async () => {
    const controller = new AbortController();
    const res = await new DwarfLinesService({
      identity,
      inspect: () => {
        controller.abort();
        return Promise.resolve(
          ok({
            ...report,
            artifact: { ...report.artifact, bytes: 4224 },
            format: "macho",
            architecture: "arm64",
            selected_slice: {
              kind: "macho-selected-image-v1",
              container: "fat",
              offset: 4096,
              byte_length: 128,
              cpu_type: 0x0100000c,
              cpu_subtype: 2,
              container_table_sha256: "b".repeat(64),
            },
            sections: [
              {
                name: "__debug_line",
                role: ".debug_line",
                offset: 4160,
                size: 32,
                compression: "none",
                uncompressed_size: 32,
              },
            ],
          }),
        );
      },
    }).inspect(
      { path: report.artifact.path, architecture: "arm64e" },
      { signal: controller.signal },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("Expected cancellation");
    expect(res.error).toBeInstanceOf(AnalysisCancelledError);
    const partial = parseEvidence(res.error.partialObservation);
    expect(partial.subject.identity.kind).toBe("file");
    if (partial.subject.identity.kind === "file") {
      expect(partial.subject.identity.architecture).toBe("arm64");
    }
    expect(partial.parameters).toEqual({
      path: report.artifact.path,
      architecture: "arm64e",
    });

    const ids: string[] = [];
    for (const parameters of [
      { path: report.artifact.path },
      {
        path: report.artifact.path,
        max_rows: 4096,
        max_file_bytes: 67_108_864,
      },
    ]) {
      const c2 = new AbortController();
      const r2 = await new DwarfLinesService({
        identity,
        inspect: () => {
          c2.abort();
          return Promise.resolve(ok(report));
        },
      }).inspect(parameters, { signal: c2.signal });
      if (r2.ok) throw new Error("Expected cancellation");
      expect(r2.error).toBeInstanceOf(AnalysisCancelledError);
      const ev2 = parseEvidence(r2.error.partialObservation);
      expect(ev2.parameters).toEqual(parameters);
      ids.push(ev2.evidence_id);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});
