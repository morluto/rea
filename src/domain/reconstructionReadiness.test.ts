import { describe, expect, it } from "vitest";

import { RECONSTRUCTION_READINESS_EXAMPLE } from "../contracts/reconstructionReadinessExample.js";
import { createReconstructionReadinessReport } from "./reconstructionReadiness.js";
import {
  reconstructionObligationLedgerClosureDigest,
  reconstructionObligationLedgerStatus,
  summarizeReconstructionObligations,
} from "./reconstructionObligationLedgerIntegrity.js";
import { reconstructionObligationLedgerSchema } from "./reconstructionObligationLedgerSchemas.js";
import {
  reconstructionReadinessInputSchema,
  type ReconstructionReadinessInput,
} from "./reconstructionReadinessSchemas.js";

const input = (
  overrides: Partial<ReconstructionReadinessInput> = {},
): ReconstructionReadinessInput => ({
  ...structuredClone(RECONSTRUCTION_READINESS_EXAMPLE),
  ...overrides,
});

describe("readiness bundle authentication", () => {
  it("authenticates each Evidence record after parsing the readiness contract", () => {
    const value = input();
    const record = value.evidence_bundle.records[0];
    if (record === undefined) throw new TypeError("Missing Evidence record");
    value.evidence_bundle.records[0] = {
      ...record,
      evidence_id: `ev_${"0".repeat(64)}`,
    };

    expect(() => createReconstructionReadinessReport(value)).toThrow(
      /Evidence semantic identifier does not match its record/u,
    );
  });

  it("rejects a noncanonical bundle manifest after readiness parsing", () => {
    const value = input();
    const provider = value.evidence_bundle.providers[0];
    if (provider === undefined)
      throw new TypeError("Missing provider manifest");
    value.evidence_bundle.providers.push(provider);

    expect(() => createReconstructionReadinessReport(value)).toThrow(
      /Evidence bundle manifests are not canonical/u,
    );
  });

  it("rejects duplicate Evidence record IDs after readiness parsing", () => {
    const value = input();
    const record = value.evidence_bundle.records[0];
    if (record === undefined) throw new TypeError("Missing Evidence record");
    value.evidence_bundle.records.push(record);

    expect(() => createReconstructionReadinessReport(value)).toThrow(
      /Evidence bundle contains duplicate record IDs/u,
    );
  });
});

describe("reconstruction readiness report", () => {
  it("accepts every caller supplied capability", () => {
    const capability = RECONSTRUCTION_READINESS_EXAMPLE.capabilities[0];
    if (capability === undefined) throw new TypeError("Missing capability");

    const parsed = reconstructionReadinessInputSchema.parse(
      input({ capabilities: Array.from({ length: 1_001 }, () => capability) }),
    );

    expect(parsed.capabilities).toHaveLength(1_001);
  });

  it("projects the complete conformance report deterministically", () => {
    const first = createReconstructionReadinessReport(input());
    const second = createReconstructionReadinessReport(input());

    expect(first.status).toBe("pass");
    expect(first.summary).toMatchObject({
      required_stages: 9,
      passed_required_stages: 9,
      findings: 0,
    });
    expect(first.report_id).toBe(second.report_id);
    expect(first.report_digest).toBe(second.report_digest);
    expect(first.metrics).toMatchObject({
      first_valid_workflow_selection_rate: 1,
      incompatible_provider_invocations: 0,
      false_equivalence_count: 0,
      unowned_obligation_count: 0,
      cleanup_leak_count: 0,
      nondeterministic_replay_count: 0,
    });
  });
});

describe("readiness obligation ledger integrity", () => {
  it("rejects a required obligation changed behind the old ledger commitment", () => {
    const value = input();
    expect(
      reconstructionObligationLedgerSchema.parse(value.obligation_ledger),
    ).toEqual(value.obligation_ledger);
    const obligation = value.obligation_ledger.obligations[0];
    if (obligation === undefined)
      throw new TypeError("Missing reconstruction obligation");
    value.obligation_ledger.obligations[0] = {
      ...obligation,
      status: "blocked",
    };

    expect(() => createReconstructionReadinessReport(value)).toThrow(
      /Ledger status does not match its obligations/u,
    );
  });

  it("rejects a recomputed commitment over a false obligation summary", () => {
    const ledger = structuredClone(input().obligation_ledger);
    ledger.summary.required_open = 1;
    ledger.closure_digest = reconstructionObligationLedgerClosureDigest(ledger);

    expect(() => reconstructionObligationLedgerSchema.parse(ledger)).toThrow(
      /Ledger summary does not match its obligations/u,
    );
  });

  it("accepts reordered summary count entries with the same keyed values", () => {
    const ledger = structuredClone(input().obligation_ledger);
    ledger.summary.by_status.reverse();
    ledger.closure_digest = reconstructionObligationLedgerClosureDigest(ledger);

    expect(reconstructionObligationLedgerSchema.parse(ledger)).toEqual(ledger);
  });

  it.each([
    [
      "reports",
      (ledger: ReconstructionReadinessInput["obligation_ledger"]) => {
        ledger.reports.missing_owner_obligation_ids.push("obl.extra");
      },
      /Ledger report does not match its obligations/u,
    ],
    [
      "ownership graph",
      (ledger: ReconstructionReadinessInput["obligation_ledger"]) => {
        const owner = ledger.ownership_graph[0];
        if (owner === undefined)
          throw new TypeError("Missing owner graph edge");
        owner.symbol = "tamperedOwner";
      },
      /Ownership graph does not match its obligations/u,
    ],
    [
      "dependency graph",
      (ledger: ReconstructionReadinessInput["obligation_ledger"]) => {
        ledger.dependency_graph.push({
          obligation_id: "obl.readiness",
          depends_on_obligation_id: "obl.extra",
        });
      },
      /Dependency graph does not match its obligations/u,
    ],
    [
      "evidence links",
      (ledger: ReconstructionReadinessInput["obligation_ledger"]) => {
        ledger.evidence_links = [];
      },
      /Evidence links omit Evidence referenced by an obligation/u,
    ],
  ] as const)(
    "rejects recomputed commitments over tampered %s",
    (_, mutate, expected) => {
      const ledger = structuredClone(input().obligation_ledger);
      mutate(ledger);
      ledger.closure_digest =
        reconstructionObligationLedgerClosureDigest(ledger);

      expect(() => reconstructionObligationLedgerSchema.parse(ledger)).toThrow(
        expected,
      );
    },
  );
});

describe("readiness failure semantics", () => {
  it("rejects equivalence over truncated concurrent evidence", () => {
    const value = input();
    const comparison = value.comparisons[0];
    if (comparison === undefined) throw new TypeError("Missing comparison");
    value.comparisons[0] = {
      ...comparison,
      schedule_semantics: "total-order",
      truncated: true,
    };
    const report = createReconstructionReadinessReport(value);

    expect(report.status).toBe("fail");
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "false-equivalence",
        "unsafe-concurrency-semantics",
      ]),
    );
    expect(report.metrics.false_equivalence_count).toBe(1);
  });

  it("keeps green stages unknown while one reconstruction obligation is open", () => {
    const value = input();
    const obligation = value.obligation_ledger.obligations[0];
    if (obligation === undefined)
      throw new TypeError("Missing reconstruction obligation");
    const obligations = [{ ...obligation, status: "blocked" as const }];
    const uncommitted = {
      ...value.obligation_ledger,
      obligations,
      status: reconstructionObligationLedgerStatus(obligations, []),
      summary: summarizeReconstructionObligations(obligations),
    };
    value.obligation_ledger = {
      ...uncommitted,
      closure_digest: reconstructionObligationLedgerClosureDigest(uncommitted),
    };
    const latest = value.closure_history.at(-1);
    if (latest === undefined) throw new TypeError("Missing closure history");
    value.closure_history[value.closure_history.length - 1] = {
      ...latest,
      ledger_digest: value.obligation_ledger.closure_digest,
      status: "open",
      required_open: 1,
      newly_verified_obligation_ids: [],
    };
    const report = createReconstructionReadinessReport(value);

    expect(report.status).toBe("unknown");
    expect(report.stages).toContainEqual(
      expect.objectContaining({
        stage_id: "verify-reconstruction-closure",
        status: "unknown",
      }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "reconstruction-closure-open" }),
    );
  });

  it("fails typed operation outcomes that ordinary automation sees as success", () => {
    const value = input();
    const cliOutcome = value.operation_outcomes[2];
    const mcpOutcome = value.operation_outcomes[3];
    if (cliOutcome === undefined || mcpOutcome === undefined)
      throw new TypeError("Missing operation outcome pair");
    value.operation_outcomes[2] = {
      ...cliOutcome,
      cli_exit_code: 0,
    };
    value.operation_outcomes[3] = {
      ...mcpOutcome,
      mcp_status: "success",
    };
    const report = createReconstructionReadinessReport(value);

    expect(report.status).toBe("fail");
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["cli-status-mismatch", "mcp-status-mismatch"]),
    );
  });

  it("detects tampering against the exported source digest", () => {
    const baseline = createReconstructionReadinessReport(input());
    const replay = input({
      replay: {
        ...RECONSTRUCTION_READINESS_EXAMPLE.replay,
        expected_source_digest: baseline.source_digest,
      },
    });
    expect(createReconstructionReadinessReport(replay).source_digest).toBe(
      baseline.source_digest,
    );
    replay.identity.cli_version = "tampered";
    const tampered = createReconstructionReadinessReport(replay);

    expect(tampered.status).toBe("fail");
    expect(tampered.findings).toContainEqual(
      expect.objectContaining({ code: "replay-source-digest-mismatch" }),
    );
  });

  it("fails a reconstruction candidate that delegates to the authority", () => {
    const value = input();
    const check = value.delegation_checks[0];
    if (check === undefined) throw new TypeError("Missing delegation check");
    value.delegation_checks[0] = {
      ...check,
      delegates_to_authority: true,
    };
    const report = createReconstructionReadinessReport(value);

    expect(report.status).toBe("fail");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "candidate-delegates-to-authority" }),
    );
  });

  it("preserves an exact unsupported stage without collapsing it to pass", () => {
    const value = input();
    const stage = value.stages.find(
      ({ stage_id: stageId }) => stageId === "reactive-scenarios",
    );
    const check = stage?.checks[0];
    if (stage === undefined || check === undefined)
      throw new TypeError("Missing reactive stage");
    stage.status = "unsupported";
    check.status = "unsupported";
    stage.capability_issue = "electron-runtime-unavailable";
    stage.next_action = "Run on a host with the approved Electron runtime.";
    const report = createReconstructionReadinessReport(value);

    expect(report.status).toBe("unsupported");
    expect(report.stages).toContainEqual(
      expect.objectContaining({
        stage_id: "reactive-scenarios",
        status: "unsupported",
      }),
    );
  });
});
