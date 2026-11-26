import { expect, it } from "vitest";
import { SolanaProgramService } from "./SolanaProgramService.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import type { SolanaProgramAnalysis } from "../../domain/solana/solanaProgram.js";
import { ok } from "../../domain/result.js";

const identity = {
  id: "solana-sbpf",
  name: "Fixture Solana analyzer seam",
  version: "1",
};

const report: SolanaProgramAnalysis = {
  artifact: {
    path: "/artifacts/pump_amm.so",
    sha256: "b".repeat(64),
    bytes: 1_048_576,
    source: "local-file",
    program_id: null,
    program_data_account: null,
    slot: null,
  },
  elf: {
    bits: 64,
    byte_order: "little",
    elf_type: 3,
    machine: 263,
    machine_name: "bpf (Solana sBPF)",
    entrypoint: 0x120,
    program_header_count: 3,
    section_header_count: 9,
    trailing_bytes: 0,
    e_flags: 0,
    sbpf_version: 0,
    sections: [
      { name: ".text", type: 1, address: 0x120, offset: 288, size: 1024 },
    ],
  },
  disassembly: {
    engine: "rea-sbpf-decoder",
    text_section: ".text",
    instruction_count: 128,
    unknown_opcodes: 0,
    call_sites: 4,
    exit_sites: 1,
    lddw_constants: 9,
    coverage: "complete",
  },
  handlers: [
    {
      method: "lddw-compare",
      discriminator: "c9cff3724b6f2fbd",
      label: null,
      name: "create_config",
      constant_address: 900392,
      constant_file_offset: 900396,
      comparison_address: 900408,
      comparison_addresses: [900408],
      branch: "jeq",
      branch_target: 901944,
      value_register: 3,
      constant_register: 4,
      table_address: null,
      table_index: null,
    },
  ],
  dispatch: {
    total_candidates: 1,
    by_method: { "lddw-compare": 1, "split-compare": 0, "table-dispatch": 0 },
    computed_jumps_unresolved: 0,
  },
  syscalls: {
    dynamic_symbols: ["sol_log_"],
    defined_symbols: 2,
    undefined_symbols: 1,
    call_sites: [
      {
        address: 900000,
        immediate: 539340733,
        resolved_name: "sol_log_",
        basis: "dynamic-symbol",
        note: null,
      },
    ],
    resolved_calls: 1,
    unresolved_calls: 0,
  },
  strings: { total: 3, relevant: [{ value: "sol_log_", file_offset: 64 }] },
  limitations: ["Fixture limitation."],
};

const serviceWith = (value: SolanaProgramAnalysis): SolanaProgramService =>
  new SolanaProgramService({
    identity,
    analyze: async () => ok(value),
  });

it("binds a validated report into artifact Evidence", async () => {
  const result = await serviceWith(report).inspect({
    path: "/artifacts/pump_amm.so",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const evidence = parseEvidence(result.value);
  expect(evidence.operation).toBe("analyze_solana_program");
  expect(evidence.subject?.identity).toMatchObject({ sha256: "b".repeat(64) });
  expect(evidence.confidence).toBe("inferred");
  const normalized = evidence.normalized_result as SolanaProgramAnalysis;
  expect(normalized.handlers[0]?.discriminator).toBe("c9cff3724b6f2fbd");
  expect(evidence.locations).toContainEqual({
    kind: "file-offset",
    offset: 900396,
  });
});

it("rejects a report that changes the selected artifact identity", async () => {
  const result = await serviceWith({
    ...report,
    artifact: { ...report.artifact, path: "/artifacts/other.so" },
  }).inspect({ path: "/artifacts/pump_amm.so" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects ambiguous source selection before invoking the analyzer", async () => {
  let calls = 0;
  const service = new SolanaProgramService({
    identity,
    analyze: async () => {
      calls += 1;
      return ok(report);
    },
  });
  const both = await service.inspect({
    path: "/artifacts/pump_amm.so",
    program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    out_dir: "/artifacts/out",
  });
  expect(both.ok).toBe(false);
  const missingOutDir = await service.inspect({
    program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  });
  expect(missingOutDir.ok).toBe(false);
  expect(calls).toBe(0);
});

const PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const rpcReport: SolanaProgramAnalysis = {
  ...report,
  artifact: {
    ...report.artifact,
    path: `/artifacts/out/${PROGRAM_ID}.so`,
    source: "solana-rpc",
    program_id: PROGRAM_ID,
  },
};

it("accepts an RPC artifact when out_dir carries a trailing separator", async () => {
  const result = await serviceWith(rpcReport).inspect({
    program_id: PROGRAM_ID,
    out_dir: "/artifacts/out/",
  });
  expect(result.ok).toBe(true);
});

it("records a credential-free RPC endpoint in Evidence", async () => {
  const result = await serviceWith(rpcReport).inspect({
    program_id: PROGRAM_ID,
    out_dir: "/artifacts/out",
    rpc_url: "https://user:pass@rpc.example.com/v2/token?api-key=secret",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const serialized = JSON.stringify(result.value);
  expect(serialized).not.toMatch(/secret|token|user:pass/);
  expect(parseEvidence(result.value).parameters).toMatchObject({
    rpc_endpoint: "https://rpc.example.com",
  });
});
