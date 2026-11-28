import { describe, expect, it } from "vitest";

import { unknownTarget } from "../../domain/targetIdentity.js";
import { createAnalysisExecution } from "../../ports/AnalysisProvider.js";
import { deliverSessionLimitations } from "./SessionLimitationContext.js";
import { admitInvestigationAuthentication } from "../investigation/InvestigationRetention.js";

const deliver = (...args: Parameters<typeof deliverSessionLimitations>) => {
  const result = deliverSessionLimitations(...args);
  if (!result.ok) throw result.error;
  return result.value;
};

const provider = { id: "fixture", name: "Fixture", version: "1" };
const target = unknownTarget("not-observed");
const execution = (call: string, session: readonly string[]) =>
  createAnalysisExecution(null, provider, {
    limitations: [call, ...session],
    sessionLimitations: session,
  });

describe("session limitation delivery", () => {
  it("keeps shared facts inline for a one-call session and drops the scope marker", () => {
    const inline = deliver(execution("call", ["a", "b"]), target, "inline");
    expect(inline.limitations).toEqual(["call", "a", "b"]);
    expect(inline).not.toHaveProperty("sessionLimitations");
    expect(inline.sourceEvidence).toBeUndefined();
  });

  it("replaces shared facts with one reference to a linked retained record", () => {
    const referenced = deliver(
      execution("call", ["a", "b"]),
      target,
      "reference",
    );
    const [context] = referenced.sourceEvidence ?? [];
    expect(context?.limitations).toEqual(["a", "b"]);
    expect(context?.normalized_result).toEqual({ limitations: ["a", "b"] });
    expect(referenced.limitations).toEqual([
      "call",
      expect.stringContaining(context?.evidence_id ?? "missing"),
    ]);
  });

  it("gives every result with the same session facts the same record", () => {
    const first = deliver(execution("one", ["a", "b"]), target, "reference");
    const second = deliver(execution("two", ["a", "b"]), target, "reference");
    const other = deliver(execution("one", ["a"]), target, "reference");
    expect(second.sourceEvidence?.[0]?.evidence_id).toBe(
      first.sourceEvidence?.[0]?.evidence_id,
    );
    expect(other.sourceEvidence?.[0]?.evidence_id).not.toBe(
      first.sourceEvidence?.[0]?.evidence_id,
    );
  });

  it("leaves an execution without session-scoped facts unchanged", () => {
    const plain = createAnalysisExecution(null, provider, {
      limitations: ["call"],
    });
    expect(deliver(plain, target, "reference")).toBe(plain);
  });
});

it("returns a typed refusal before copying a reference context when headroom is exhausted", () => {
  const result = deliverSessionLimitations(
    execution("call", ["shared"]),
    target,
    "reference",
    (value, operation, additional) =>
      admitInvestigationAuthentication(
        value,
        operation,
        { availableAuthenticationBytes: () => 0 },
        additional,
      ),
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
});
