import { describe, expect, it } from "vitest";

import { UnknownRegistry } from "../src/application/UnknownRegistry.js";

const limits = { maxRecords: 100, maxRelationships: 50 };

const baseRecordInput = {
  question: "What triggers the notification delegate?",
  severity: "high" as const,
  domain: "notifications",
  required_authority: "shipped-artifact" as const,
  required_confidence: "observed" as const,
  required_environment: null,
  supporting_evidence_ids: [] as string[],
  contradicting_evidence_ids: [] as string[],
  recommended_probes: [],
  relationships: [],
  approved: true as const,
};

describe("UnknownRegistry", () => {
  it("creates a registry entry with deterministic ID and revision 1", () => {
    const registry = new UnknownRegistry(limits);
    const result = registry.recordUnknown(
      baseRecordInput,
      "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unk = result.value;
    expect(unk.unknown_id).toMatch(/^unk_[a-f0-9]{64}$/u);
    expect(unk.revision).toBe(1);
    expect(unk.status).toBe("open");
    expect(unk.previous_revision_digest).toBeNull();
  });

  it("rejects duplicate creation with already-exists", () => {
    const registry = new UnknownRegistry(limits);
    const first = registry.recordUnknown(
      baseRecordInput,
      "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    );
    expect(first.ok).toBe(true);
    const second = registry.recordUnknown(
      baseRecordInput,
      "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.reason).toBe("already-exists");
  });

  it("updates status and bumps revision with optimistic concurrency", () => {
    const registry = new UnknownRegistry(limits);
    const created = registry.recordUnknown(
      baseRecordInput,
      "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    );
    if (!created.ok) throw new Error("create failed");
    const updated = registry.updateUnknown(
      {
        unknown_id: created.value.unknown_id,
        expected_revision: 1,
        approved: true,
        status: "investigating",
        severity: "high",
        required_authority: null,
        required_confidence: "observed",
        required_environment: null,
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        recommended_probes: [],
        relationships: [],
        resolution: null,
      },
      "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.revision).toBe(2);
    expect(updated.value.status).toBe("investigating");
    expect(updated.value.previous_revision_digest).toBe(
      created.value.revision_digest,
    );
  });

  it("rejects update with wrong expected revision", () => {
    const registry = new UnknownRegistry(limits);
    const created = registry.recordUnknown(
      baseRecordInput,
      "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    );
    if (!created.ok) throw new Error("create failed");
    const updated = registry.updateUnknown(
      {
        unknown_id: created.value.unknown_id,
        expected_revision: 99,
        approved: true,
        status: "investigating",
        severity: "high",
        required_authority: null,
        required_confidence: "observed",
        required_environment: null,
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        recommended_probes: [],
        relationships: [],
        resolution: null,
      },
      "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error.reason).toBe("revision-conflict");
  });

  it("rejects update of non-existent unknown", () => {
    const registry = new UnknownRegistry(limits);
    const updated = registry.updateUnknown(
      {
        unknown_id: "unk_" + "0".repeat(64),
        expected_revision: 1,
        approved: true,
        status: "investigating",
        severity: "high",
        required_authority: null,
        required_confidence: "observed",
        required_environment: null,
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        recommended_probes: [],
        relationships: [],
        resolution: null,
      },
      "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error.reason).toBe("not-found");
  });

  it("lists unknowns filtered by status and domain", () => {
    const registry = new UnknownRegistry(limits);
    const a = registry.recordUnknown(
      { ...baseRecordInput, domain: "notifications" },
      "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    );
    const b = registry.recordUnknown(
      { ...baseRecordInput, question: "How does IPC work?", domain: "ipc" },
      "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const allOpen = registry.listUnknowns({ status: "open" });
    expect(allOpen.ok).toBe(true);
    if (!allOpen.ok) return;
    expect(allOpen.value).toHaveLength(2);

    const ipcOnly = registry.listUnknowns({ domain: "ipc" });
    expect(ipcOnly.ok).toBe(true);
    if (!ipcOnly.ok) return;
    expect(ipcOnly.value).toHaveLength(1);
    expect(ipcOnly.value[0]?.domain).toBe("ipc");
  });

  it("verifies resolution requires verified disposition", () => {
    const registry = new UnknownRegistry(limits);
    const created = registry.recordUnknown(
      baseRecordInput,
      "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    );
    if (!created.ok) throw new Error("create failed");

    // Cannot resolve without verified evidence
    const unresolved = registry.updateUnknown(
      {
        unknown_id: created.value.unknown_id,
        expected_revision: 1,
        approved: true,
        status: "resolved",
        severity: "high",
        required_authority: null,
        required_confidence: "observed",
        required_environment: null,
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        recommended_probes: [],
        relationships: [],
        resolution: {
          disposition: "verified",
          rationale: "Test resolved",
          evidence_ids: [],
        },
      },
      "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    );
    // The domain layer should reject resolving with verified disposition
    // and no evidence ids
    expect(unresolved.ok).toBe(false);
  });

  it("enforces record limits", () => {
    const smallLimits = { maxRecords: 2, maxRelationships: 50 };
    const registry = new UnknownRegistry(smallLimits);
    expect(
      registry.recordUnknown(
        baseRecordInput,
        "ev_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      ).ok,
    ).toBe(true);
    expect(
      registry.recordUnknown(
        { ...baseRecordInput, question: "Second?" },
        "ev_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
      ).ok,
    ).toBe(true);
    const third = registry.recordUnknown(
      { ...baseRecordInput, question: "Third?" },
      "ev_c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
    );
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.reason).toBe("limit");
  });
});
