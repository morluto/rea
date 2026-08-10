import { describe, expect, it } from "vitest";

import { RECONSTRUCTION_READINESS_EXAMPLE } from "../contracts/reconstructionReadinessExample.js";
import { createReconstructionReadinessReport } from "./reconstructionReadiness.js";
import type { ReconstructionReadinessInput } from "./reconstructionReadinessSchemas.js";

const input = (
  overrides: Partial<ReconstructionReadinessInput> = {},
): ReconstructionReadinessInput => ({
  ...structuredClone(RECONSTRUCTION_READINESS_EXAMPLE),
  ...overrides,
});

describe("reconstruction readiness report", () => {
  it("passes the complete public-contract journey deterministically", () => {
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
    value.obligation_ledger = {
      ...value.obligation_ledger,
      status: "open",
      summary: {
        ...value.obligation_ledger.summary,
        verified: 0,
        required_open: 1,
      },
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
