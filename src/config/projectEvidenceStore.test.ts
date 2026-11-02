import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { parseConfig } from "./parseConfig.js";

it("keeps project Evidence persistence off by default", () => {
  const parsed = parseConfig({});
  if (!parsed.ok) throw new Error("default configuration was rejected");
  expect(parsed.value.evidenceStoreRoot).toBeUndefined();
});

it("resolves the project Evidence store root from the environment", () => {
  const root = resolve("project", ".rea", "evidence");
  const parsed = parseConfig({
    REA_EVIDENCE_STORE: "project",
    REA_EVIDENCE_STORE_DIR: root,
  });
  if (!parsed.ok) throw new Error("project Evidence store was rejected");
  expect(parsed.value.evidenceStoreRoot).toBe(root);
});

it("defaults the project store root to .rea/evidence in the working directory", () => {
  const parsed = parseConfig({ REA_EVIDENCE_STORE: "project" });
  if (!parsed.ok)
    throw new Error("default project Evidence store was rejected");
  expect(parsed.value.evidenceStoreRoot).toBe(
    join(process.cwd(), ".rea", "evidence"),
  );
});

it("rejects a relative project Evidence store root", () => {
  const parsed = parseConfig({
    REA_EVIDENCE_STORE: "project",
    REA_EVIDENCE_STORE_DIR: "relative/evidence",
  });
  expect(parsed.ok).toBe(false);
});
