import { join } from "node:path";

import { expect, it } from "vitest";

import { ProjectEvidenceStore } from "../../src/application/investigation/ProjectEvidenceStore.js";
import {
  createArtifactBinarySession,
  createManagedBinarySession,
  createNativeBinarySession,
} from "../../src/composition/binary.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../src/contracts/functionComparisonExample.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("wires project Evidence storage into artifact and managed sessions", async () => {
  const root = await createTestTempDirectory("rea-session-store-");
  const storeRoot = join(root, "store");
  const environment = {
    REA_EVIDENCE_STORE: "project",
    REA_EVIDENCE_STORE_DIR: storeRoot,
  };
  const created = [
    await createArtifactBinarySession(environment),
    createManagedBinarySession(environment),
    ...(process.platform === "darwin"
      ? [await createNativeBinarySession(environment)]
      : []),
  ];
  for (const session of created) {
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.left).ok).toBe(
      true,
    );
    const closed = await session.close();
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
  }
  const store = new ProjectEvidenceStore(storeRoot);
  expect(store.read(FUNCTION_COMPARISON_EXAMPLE.left.evidence_id)).toEqual(
    FUNCTION_COMPARISON_EXAMPLE.left,
  );
});
