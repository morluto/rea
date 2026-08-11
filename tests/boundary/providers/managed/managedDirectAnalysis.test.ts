import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { runProviderAnalysis } from "../../../../src/application/DirectAnalysis.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";

describe("managed direct-analysis path boundary", () => {
  it("returns provider evidence through the shared analysis service", async () => {
    const directory = await createTestTempDirectory("rea-managed-cli-");
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());

    const evidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_artifact", {
        reference_limit: 1,
      }),
    );
    expect(evidence).toMatchObject({
      operation: "inspect_managed_artifact",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        classification: { status: "managed", runtime_family: "modern-dotnet" },
        references: { limit: 1 },
      },
    });

    const memberEvidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_members", {}),
    );
    expect(memberEvidence).toMatchObject({
      operation: "inspect_managed_members",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        identity_scope: { token_identity: "build-local" },
        methods: { total: 1 },
      },
    });

    const boundaryEvidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_native_boundaries", {}),
    );
    expect(boundaryEvidence).toMatchObject({
      operation: "inspect_managed_native_boundaries",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        identity_scope: { token_identity: "build-local" },
        pinvoke_imports: { total: 0 },
      },
    });
  });
});
