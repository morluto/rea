import { expect, it, vi } from "vitest";
import { z } from "zod";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { createAnalysisExecutionEvidence } from "../../domain/analysisObservation.js";
import { MAX_EVIDENCE_JSON_DEPTH } from "../../domain/evidence.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../../domain/jsonValue.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { BinarySessionRecords } from "../binary/BinarySessionRecords.js";
import { estimateJsonStorage } from "../JsonAuthenticationHeadroom.js";
import { InvestigationRecords } from "./InvestigationRecords.js";
import {
  admitInvestigationAuthentication,
  type RecoveryAdmission,
} from "./InvestigationRetention.js";
import { admitCompletedAnalysis } from "./admitCompletedAnalysis.js";

class TestSessionRecords extends BinarySessionRecords {
  protected activeAnalysisBinding() {
    return undefined;
  }
}

const provider = {
  id: "fixture",
  name: "Envelope depth fixture",
  version: "1",
};
const nested = (depth: number): Record<string, JsonValue> => {
  let value: JsonValue = "leaf";
  for (let level = 0; level < depth; level++) value = { child: value };
  return value as Record<string, JsonValue>;
};
const fields = ["result", "rawResult", "parameters", "profile"] as const;
const observation = (field: (typeof fields)[number], depth: number) => ({
  parameters: field === "parameters" ? nested(depth) : {},
  execution: createAnalysisExecution(
    field === "result" ? nested(depth) : "small",
    provider,
    {
      rawResult: field === "rawResult" ? nested(depth) : null,
      ...(field === "profile"
        ? { analysisProfile: createAnalysisProfile(provider, nested(depth)) }
        : {}),
    },
  ),
});

it.each(["default", "records", "session"] as const)(
  "admits independently bounded completed fields through the %s adapter",
  (adapter) => {
    const records = new InvestigationRecords({
      availableAuthenticationBytes: () => Number.MAX_SAFE_INTEGER,
    });
    const session = new TestSessionRecords(records);
    const admit =
      adapter === "default"
        ? undefined
        : adapter === "records"
          ? records.admitRecoveryObservation.bind(records)
          : session.admitRecoveryObservation.bind(session);
    for (const field of fields)
      for (const depth of [999, MAX_JSON_DEPTH]) {
        const { parameters, execution } = observation(field, depth);
        const result = admitCompletedAnalysis(
          "health",
          parameters,
          execution,
          admit,
        );
        if (!result.ok) throw result.error;
        const evidence = createAnalysisExecutionEvidence(
          "health",
          parameters,
          execution,
          "observed",
        );
        const recorded = records.recordEvidence(evidence);
        if (!recorded.ok) throw recorded.error;
        expect(JSON.stringify(records.evidenceById(evidence.evidence_id))).toBe(
          JSON.stringify(evidence),
        );
      }
    expect(records.statistics().evidenceRecords).toBe(8);
  },
);

it.each(["helper", "records", "session"] as const)(
  "preserves default depth and additional headroom through %s",
  (adapter) => {
    let available = Number.MAX_SAFE_INTEGER;
    const readAvailable = vi.fn(() => available);
    const policy = { availableAuthenticationBytes: readAvailable };
    const records = new InvestigationRecords(policy);
    const session = new TestSessionRecords(records);
    const admit: RecoveryAdmission =
      adapter === "helper"
        ? (input, operation, additional, depth) =>
            admitInvestigationAuthentication(
              input,
              operation,
              policy,
              additional,
              depth,
            )
        : adapter === "records"
          ? records.admitRecoveryObservation.bind(records)
          : session.admitRecoveryObservation.bind(session);
    const additional = { valueBytes: 8192, serializedUtf16Bytes: 2048 };
    const deep = nested(MAX_JSON_DEPTH + 1);
    expect(admit(deep, "health", additional)).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    expect(readAvailable).not.toHaveBeenCalled();
    for (const [input, depth] of [
      [{ result: "small" }, undefined],
      [deep, MAX_EVIDENCE_JSON_DEPTH],
    ] as const) {
      const base = estimateJsonStorage(input);
      const valueBytes = base.valueBytes + additional.valueBytes;
      const serialized =
        base.serializedUtf16Bytes + additional.serializedUtf16Bytes;
      const total = 2 * (valueBytes + serialized);
      available = total - 1;
      expect(admit(input, "health", additional, depth)).toMatchObject({
        ok: false,
        error: {
          resource: "memory",
          reportedLimits: {
            projected_value_bytes: valueBytes,
            serialized_json_utf16_bytes: serialized,
            authentication_bytes: total,
            available_heap_bytes: total - 1,
          },
        },
      });
      available = total;
      expect(admit(input, "health", additional, depth)).toEqual({
        ok: true,
        value: undefined,
      });
    }
  },
);

it("forwards generated source-link and missing-subject accounting with the envelope depth", () => {
  let available = 0;
  const records = new InvestigationRecords({
    availableAuthenticationBytes: () => available,
  });
  const session = new TestSessionRecords(records);
  const source = createAnalysisExecutionEvidence(
    "health",
    {},
    createAnalysisExecution("source", provider),
    "observed",
  );
  const execution = createAnalysisExecution(nested(MAX_JSON_DEPTH), provider, {
    sourceEvidence: [source],
    subject: null,
  });
  const admitted = () =>
    admitCompletedAnalysis(
      "health",
      {},
      execution,
      session.admitRecoveryObservation.bind(session),
    );
  const refused = admitted();
  if (refused.ok || !(refused.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected memory refusal after envelope admission");
  const actual = estimateJsonStorage(
    createAnalysisExecutionEvidence("health", {}, execution, "observed"),
  );
  expect(
    refused.error.reportedLimits?.projected_value_bytes,
  ).toBeGreaterThanOrEqual(actual.valueBytes);
  expect(
    refused.error.reportedLimits?.serialized_json_utf16_bytes,
  ).toBeGreaterThanOrEqual(actual.serializedUtf16Bytes);
  const required = refused.error.reportedLimits?.authentication_bytes;
  if (typeof required !== "number")
    throw new Error("Missing authentication cost");
  available = required - 1;
  expect(admitted()).toMatchObject({
    ok: false,
    error: { resource: "memory" },
  });
  available = required;
  expect(admitted()).toEqual({ ok: true, value: undefined });
  expect(records.statistics().evidenceRecords).toBe(0);
});

it.each(fields)(
  "keeps %s independently bounded before Evidence can be retained",
  (field) => {
    expect(() => {
      const { parameters, execution } = observation(field, MAX_JSON_DEPTH + 1);
      return createAnalysisExecutionEvidence(
        "health",
        parameters,
        execution,
        "observed",
      );
    }).toThrow(z.ZodError);
  },
);

it.each(fields)(
  "rejects completed %s at depth 1001 before budgeting",
  (field) => {
    const readAvailable = vi.fn(() => Number.MAX_SAFE_INTEGER);
    const records = new InvestigationRecords({
      availableAuthenticationBytes: readAvailable,
    });
    const session = new TestSessionRecords(records);
    const base = observation("profile", 1);
    const execution = {
      ...base.execution,
      ...(field === "result" ? { result: nested(MAX_JSON_DEPTH + 1) } : {}),
      ...(field === "rawResult"
        ? { rawResult: nested(MAX_JSON_DEPTH + 1) }
        : {}),
      ...(field === "profile"
        ? {
            analysisProfile: {
              ...base.execution.analysisProfile!,
              parameters: nested(MAX_JSON_DEPTH + 1),
            },
          }
        : {}),
    };
    const result = admitCompletedAnalysis(
      "health",
      field === "parameters" ? nested(MAX_JSON_DEPTH + 1) : {},
      execution,
      session.admitRecoveryObservation.bind(session),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        userMessage: expect.stringContaining("maximum nesting depth of 1000"),
        sourcePublicationRecovery: {
          completed: { kind: "omitted", reason: "recovery-input-invalid" },
        },
      },
    });
    expect(readAvailable).not.toHaveBeenCalled();
    expect(records.statistics().evidenceRecords).toBe(0);
  },
);

it.each([
  "profile-proxy",
  "profile-accessor",
  "payload-proxy",
  "payload-accessor",
] as const)(
  "rejects completed %s without executing user code or budgeting",
  (kind) => {
    const effect = vi.fn(() => {
      throw new Error("User code must not run during admission");
    });
    const readAvailable = vi.fn(() => Number.MAX_SAFE_INTEGER);
    const records = new InvestigationRecords({
      availableAuthenticationBytes: readAvailable,
    });
    const base = observation("profile", 1).execution;
    const proxy = <T extends object>(value: T): T =>
      new Proxy(value, {
        get: effect,
        ownKeys: effect,
        getOwnPropertyDescriptor: effect,
        getPrototypeOf: effect,
      });
    const accessor = {
      get child(): JsonValue {
        return effect();
      },
    };
    const execution = {
      ...base,
      ...(kind === "profile-proxy"
        ? { analysisProfile: proxy(base.analysisProfile!) }
        : {}),
      ...(kind === "profile-accessor"
        ? {
            analysisProfile: {
              ...base.analysisProfile!,
              get parameters(): Record<string, JsonValue> {
                return effect();
              },
            },
          }
        : {}),
      ...(kind === "payload-proxy" ? { result: proxy({ child: "leaf" }) } : {}),
      ...(kind === "payload-accessor" ? { rawResult: accessor } : {}),
    };
    expect(
      admitCompletedAnalysis(
        "health",
        {},
        execution,
        records.admitRecoveryObservation.bind(records),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        sourcePublicationRecovery: {
          completed: { kind: "omitted", reason: "recovery-input-invalid" },
        },
      },
    });
    expect(effect).not.toHaveBeenCalled();
    expect(readAvailable).not.toHaveBeenCalled();
    expect(records.statistics().evidenceRecords).toBe(0);
  },
);
