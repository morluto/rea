import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { dotnetBundleFixture } from "../../src/artifacts/dotnet/DotnetBundle.fixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("refuses at the artifact.member_count session value and admits the same bundle when it is raised over stdio MCP", async () => {
  const root = await createTestTempDirectory("rea-artifact-member-count-");
  const path = join(root, "bundle.bin");
  await writeFile(
    path,
    dotnetBundleFixture([
      { path: "first.txt", bytes: Buffer.from("first") },
      { path: "second.txt", bytes: Buffer.from("second") },
    ]).bytes,
  );
  const { call } = await connectLocalToolsMcp({});
  const setMemberCount = async (value: number) => {
    const result = await call("update_analysis_settings", {
      changes: [{ setting: "artifact.member_count", action: "set", value }],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
  };
  expect((await call("open_binary", { path })).isError).not.toBe(true);

  await setMemberCount(1);
  const refused = await call("inspect_artifact", {});
  expect(refused.isError).toBe(true);
  const { error } = parseMcpToolError(refused);
  expect(error).toMatchObject({
    details: {
      limit: {
        setting: "artifact.member_count",
        parameter: "artifact_limits.dotnet_bundle.entry_count",
        effective_value: 1,
        source: "runtime",
      },
      refusal: {
        kind: "adjustable_budget",
        setting: "artifact.member_count",
        effective_value: 1,
      },
      reader_limit: {
        parameter: "artifact_limits.dotnet_bundle.entry_count",
      },
    },
  });
  // Both routes: the per-call field for this call, the setting for the session.
  expect(error.remediation.action).toContain(
    "artifact_limits.dotnet_bundle.entry_count",
  );
  expect(error.remediation.action).toContain("update_analysis_settings");
  expect(error.remediation.action).toContain("artifact.member_count");

  // An explicit artifact_limits field wins over the session value.
  const selected = await call("inspect_artifact", {
    artifact_limits: { dotnet_bundle: { entry_count: 2 } },
  });
  expect(selected.isError, JSON.stringify(selected)).not.toBe(true);

  await setMemberCount(2);
  const admitted = await call("inspect_artifact", {});
  expect(admitted.isError, JSON.stringify(admitted)).not.toBe(true);
  await call("close_binary", {});
});
