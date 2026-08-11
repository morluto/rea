import { describe, expect, it } from "vitest";

import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createInvestigationWorkspace } from "../../../src/domain/investigationWorkspace.js";

describe("binary session", () => {
  it("returns detached provider, target, and workspace metadata", async () => {
    const [first] = await createBinarySessionTargets();
    const session = createTestBinarySession(createCacheProvider([]));
    expect((await session.open(first)).ok).toBe(true);
    expect(session.status()).toMatchObject({
      analysis_run: {
        run_id: expect.any(String),
        process_lineage: { status: "not_observed" },
      },
    });
    expect(session.listUnknowns()).toEqual([]);
    const identity = session.providerIdentity();
    Reflect.set(identity, "id", "forged");
    expect(session.providerIdentity().id).toBe("fixture");

    const active = session.activeTarget();
    expect(active).toBeDefined();
    if (active !== undefined) Reflect.set(active, "path", "/tmp/forged");
    expect(session.activeTarget()?.path).toBe(first);

    const workspace = createInvestigationWorkspace(
      "Detached workspace",
      createEvidenceBundle([]),
      [],
    );
    expect(session.retainInvestigationWorkspace(workspace)).toBe("added");
    const direct = session.investigationWorkspace(workspace.workspace_id, 1);
    if (direct !== undefined) Reflect.set(direct, "revision", 999);
    const listed = session.investigationWorkspaces()[0];
    if (listed !== undefined) Reflect.set(listed, "workspace_id", "forged");
    expect(
      session.investigationWorkspace(workspace.workspace_id, 1),
    ).toMatchObject({ revision: 1, workspace_id: workspace.workspace_id });
    await session.close();
  });
});
