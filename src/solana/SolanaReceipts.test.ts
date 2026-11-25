import { describe, expect, it } from "vitest";

import type { SolanaProgramAnalysis } from "../domain/solana/solanaProgram.js";
import type { SolanaReceiptEvidence } from "../domain/solana/solanaReceipts.js";
import {
  buildProgramReceipts,
  SolanaReceiptsFailure,
} from "./SolanaReceipts.js";

const SHA = "a".repeat(64);

const analysis: SolanaProgramAnalysis = {
  artifact: {
    path: "/artifacts/pump_amm.so",
    sha256: SHA,
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
    entrypoint: 0x100,
    program_header_count: 3,
    section_header_count: 9,
    trailing_bytes: 0,
    e_flags: 0,
    sbpf_version: 0,
    sections: [],
  },
  disassembly: {
    engine: "rea-sbpf-decoder",
    text_section: ".text",
    instruction_count: 10,
    unknown_opcodes: 0,
    call_sites: 0,
    exit_sites: 1,
    lddw_constants: 2,
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
      branch_target: 901912,
      value_register: 3,
      constant_register: 4,
      table_address: null,
      table_index: null,
    },
    {
      method: "lddw-compare",
      discriminator: "1122334455667788",
      label: null,
      name: null,
      constant_address: 900500,
      constant_file_offset: 900504,
      comparison_address: 900516,
      comparison_addresses: [900516],
      branch: "jne",
      branch_target: 902000,
      value_register: 3,
      constant_register: 4,
      table_address: null,
      table_index: null,
    },
    {
      method: "table-dispatch",
      discriminator: null,
      label: "index:2",
      name: null,
      constant_address: null,
      constant_file_offset: null,
      comparison_address: null,
      comparison_addresses: [],
      branch: null,
      branch_target: 903000,
      value_register: null,
      constant_register: null,
      table_address: 4096,
      table_index: 2,
    },
  ],
  dispatch: {
    total_candidates: 3,
    by_method: { "lddw-compare": 2, "split-compare": 0, "table-dispatch": 1 },
    computed_jumps_unresolved: 0,
  },
  syscalls: {
    dynamic_symbols: [],
    defined_symbols: 0,
    undefined_symbols: 0,
    call_sites: [],
    resolved_calls: 0,
    unresolved_calls: 0,
  },
  strings: { total: 0, relevant: [] },
  limitations: [],
};

const evidenceWith = (
  handlers: SolanaReceiptEvidence["handlers"],
): SolanaReceiptEvidence => ({
  program: { elf_sha256: SHA },
  handlers,
});

describe("buildProgramReceipts verdicts", () => {
  it("marks every candidate a lead when no evidence is supplied", () => {
    const doc = buildProgramReceipts(analysis, undefined, "/a.json", "/r.json");
    expect(doc.summary).toMatchObject({
      total_candidates: 3,
      recovered: 0,
      leads: 3,
      orphans: [],
      issues: [],
    });
    expect(doc.program.analysis_path).toBe("/a.json");
    expect(doc.program.receipts_path).toBe("/r.json");
  });

  it("issues a recovered receipt for complete all-pass fixtures", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          discriminator: "c9cff3724b6f2fbd",
          verdict: "recovered",
          fixtures: { total: 6, passed: 6 },
          vm: "litesvm",
          evidence_refs: ["repro/pump_amm/create-config/"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    const receipt = doc.receipts[0];
    expect(receipt?.verdict).toBe("recovered");
    expect(receipt?.fixtures).toEqual({ total: 6, passed: 6 });
    expect(receipt?.vm).toBe("litesvm");
    expect(doc.summary.recovered).toBe(1);
    expect(doc.summary.leads).toBe(2);
  });

  it("resolves a name-only entry through its Anchor discriminator", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          name: "create_config",
          verdict: "recovered",
          fixtures: { total: 6, passed: 6 },
          vm: "litesvm",
          evidence_refs: ["tx:2gNxbFQQ"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    expect(doc.receipts[0]?.verdict).toBe("recovered");
    expect(doc.receipts[0]?.name).toBe("create_config");
    expect(doc.summary.orphans).toHaveLength(0);
  });

  it("accepts an as-recorded note in place of aggregate-only fixture counts", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          discriminator: "1122334455667788",
          verdict: "recovered",
          fixtures_note:
            "Bounded per repro/completion.json; counts kept in aggregate corpora.",
          vm: "litesvm",
          evidence_refs: ["repro/completion.json"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    const receipt = doc.receipts[1];
    expect(receipt?.verdict).toBe("recovered");
    expect(receipt?.fixtures).toBeNull();
    expect(receipt?.notes).toContain("aggregate corpora");
  });

  it("downgrades a recovered claim whose fixtures are incomplete", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          discriminator: "c9cff3724b6f2fbd",
          verdict: "recovered",
          fixtures: { total: 6, passed: 5 },
          vm: "litesvm",
          evidence_refs: ["repro/x"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    expect(doc.receipts[0]?.verdict).toBe("lead");
    expect(doc.summary.issues.join(" ")).toContain("5/6");
  });

  it("downgrades a recovered claim with neither fixtures nor a note", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          discriminator: "c9cff3724b6f2fbd",
          verdict: "recovered",
          vm: "litesvm",
          evidence_refs: ["repro/x"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    expect(doc.receipts[0]?.verdict).toBe("lead");
    expect(doc.summary.issues).toHaveLength(1);
  });

  it("carries failed and not-a-handler verdicts as recorded", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          discriminator: "c9cff3724b6f2fbd",
          verdict: "failed",
          fixtures: { total: 4, passed: 1 },
          vm: "surfpool",
          evidence_refs: ["repro/y"],
        },
        {
          discriminator: "1122334455667788",
          verdict: "not-a-handler",
          vm: "litesvm",
          evidence_refs: ["repro/z"],
          notes: "Constant is a fee bitmask, not a dispatch discriminator.",
        },
      ]),
      "/a.json",
      "/r.json",
    );
    expect(doc.receipts[0]?.verdict).toBe("failed");
    expect(doc.receipts[1]?.verdict).toBe("not-a-handler");
    expect(doc.summary).toMatchObject({ failed: 1, not_a_handler: 1 });
  });
});

describe("buildProgramReceipts integrity", () => {
  it("reports entries matching no candidate as orphans, by discriminator and by name", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          discriminator: "deadbeefdeadbeef",
          verdict: "recovered",
          fixtures: { total: 1, passed: 1 },
          vm: "litesvm",
          evidence_refs: ["repro/orphan"],
        },
        {
          name: "nonexistent_instruction",
          verdict: "failed",
          vm: "litesvm",
          evidence_refs: ["repro/orphan2"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    expect(doc.summary.orphans).toHaveLength(2);
    expect(doc.summary.orphans[0]?.discriminator).toBe("deadbeefdeadbeef");
    expect(doc.summary.orphans[1]?.name).toBe("nonexistent_instruction");
    expect(doc.summary.orphans[1]?.discriminator).toMatch(/^[a-f0-9]{16}$/);
    expect(doc.summary.leads).toBe(3);
  });

  it("refuses evidence bound to a different artifact", () => {
    expect(() =>
      buildProgramReceipts(
        analysis,
        { program: { elf_sha256: "b".repeat(64) }, handlers: [] },
        "/a.json",
        "/r.json",
      ),
    ).toThrow(SolanaReceiptsFailure);
  });

  it("refuses two entries claiming one handler", () => {
    expect(() =>
      buildProgramReceipts(
        analysis,
        evidenceWith([
          {
            discriminator: "c9cff3724b6f2fbd",
            verdict: "recovered",
            fixtures: { total: 1, passed: 1 },
            vm: "litesvm",
            evidence_refs: ["a"],
          },
          {
            name: "create_config",
            verdict: "failed",
            vm: "litesvm",
            evidence_refs: ["b"],
          },
        ]),
        "/a.json",
        "/r.json",
      ),
    ).toThrow(SolanaReceiptsFailure);
  });

  it("refuses an entry whose name and discriminator disagree", () => {
    expect(() =>
      buildProgramReceipts(
        analysis,
        evidenceWith([
          {
            discriminator: "1122334455667788",
            name: "create_config",
            verdict: "recovered",
            fixtures: { total: 1, passed: 1 },
            vm: "litesvm",
            evidence_refs: ["a"],
          },
        ]),
        "/a.json",
        "/r.json",
      ),
    ).toThrow(SolanaReceiptsFailure);
  });

  it("receipts a table-dispatch row by its table slot", () => {
    const doc = buildProgramReceipts(
      analysis,
      evidenceWith([
        {
          table: { address: 4096, index: 2 },
          verdict: "recovered",
          fixtures: { total: 3, passed: 3 },
          vm: "litesvm",
          evidence_refs: ["repro/table-2/"],
        },
        {
          table: { address: 4096, index: 9 },
          verdict: "failed",
          vm: "litesvm",
          evidence_refs: ["repro/table-9/"],
        },
      ]),
      "/a.json",
      "/r.json",
    );
    const tableReceipt = doc.receipts.find(
      (receipt) => receipt.table_address === 4096,
    );
    expect(tableReceipt?.verdict).toBe("recovered");
    expect(tableReceipt?.table_index).toBe(2);
    expect(doc.summary.recovered).toBe(1);
    expect(doc.summary.orphans).toHaveLength(1);
    expect(doc.summary.orphans[0]?.table_index).toBe(9);
  });
});
