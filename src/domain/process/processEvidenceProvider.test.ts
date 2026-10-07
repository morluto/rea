import { expect, it } from "vitest";

import {
  PROCESS_PROVIDER,
  isProcessEvidenceProvider,
} from "./processEvidenceProvider.js";

it.each(["REA process capture", "REA deterministic process harness"])(
  "accepts the exact v3 process provider name %s",
  (name) => {
    expect(isProcessEvidenceProvider({ ...PROCESS_PROVIDER, name })).toBe(true);
  },
);

it.each([
  { name: "REA process capture extra" },
  { name: "REA deterministic process harness extra" },
  { name: "rea process capture" },
  { name: "REA Process Capture" },
  { name: " REA process capture" },
  { name: "REA process capture " },
  { name: "REA deterministic process harness " },
  { name: "Fixture process provider" },
  { id: "fixture-process" },
  { version: "2" },
  { version: "4" },
  { version: null },
])("rejects other process identities: %j", (change) => {
  expect(isProcessEvidenceProvider({ ...PROCESS_PROVIDER, ...change })).toBe(
    false,
  );
});
