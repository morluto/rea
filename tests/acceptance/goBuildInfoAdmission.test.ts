import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, runFileCli } from "../support/cli/cliFixture.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { goBuildInfoAdmissionFixture } from "../fixtures/go/admission.js";
import { evidenceResultOf } from "../../src/contracts/toolOutputSchemaPrimitives.js";
import { goBinarySchema } from "../../src/domain/go/goBinary.js";

cliTest(
  "repairs an invalid Go launch seed in the same MCP session and restores its failure on reset",
  async () => {
    const root = await createTestTempDirectory("rea-go-invalid-seed-");
    const path = join(root, "application.elf");
    await writeFile(path, goBuildInfoAdmissionFixture(64).bytes);
    const { call } = await connectLocalToolsMcp({
      REA_GO_MAX_BUILD_INFO_BYTES: "0",
    });
    const inspect = () => call("inspect_go_binary", { path });
    expect(parseMcpToolError(await inspect())).toMatchObject({
      error: { code: "configuration_invalid" },
    });
    const changed = await call("update_analysis_settings", {
      changes: [
        { setting: "go.max_build_info_bytes", action: "set", value: 64 },
      ],
    });
    expect(changed.isError).not.toBe(true);
    expect((await inspect()).isError).not.toBe(true);
    const reset = await call("update_analysis_settings", {
      changes: [{ setting: "go.max_build_info_bytes", action: "reset" }],
    });
    expect(reset.isError).not.toBe(true);
    expect(parseMcpToolError(await inspect())).toMatchObject({
      error: { code: "configuration_invalid" },
    });
  },
);

cliTest(
  "raises and resets Go admission over real stdio and honors the CLI launch seed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-go-admission-public-");
    const path = join(root, "padded.elf");
    const fixture = goBuildInfoAdmissionFixture(1048577);
    await writeFile(path, fixture.bytes);
    const { call } = await connectLocalToolsMcp();
    const inspect = () =>
      call("inspect_go_binary", { path, detail: "summary" });
    const denied = await inspect();
    expect(parseMcpToolError(denied)).toMatchObject({
      error: {
        code: "resource_constraint",
        details: {
          limit: {
            setting: "go.max_build_info_bytes",
            effective_value: 1048576,
            source: "default",
            maximum: 16777216,
          },
        },
      },
    });
    const update = (action: "set" | "reset", value?: number) =>
      call("update_analysis_settings", {
        changes: [
          {
            setting: "go.max_build_info_bytes",
            action,
            ...(value === undefined ? {} : { value }),
          },
        ],
      });
    expect((await update("set", 1048577)).isError).not.toBe(true);
    const accepted = await inspect();
    expect(accepted.isError, JSON.stringify(accepted)).not.toBe(true);
    // Reset must re-enforce the launch allowance on the identical file/session.
    expect((await update("reset")).isError).not.toBe(true);
    expect(parseMcpToolError(await inspect())).toMatchObject({
      error: { code: "resource_constraint" },
    });
    expect((await update("set", 16777217)).isError).toBe(true);

    const result = await runFileCli(cli, {
      arguments: ["inspect-go-binary", path, "--json"],
      environment: { REA_GO_MAX_BUILD_INFO_BYTES: "1048577" },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = evidenceResultOf(goBinarySchema).parse(result.json);
    expect(evidence.normalized_result.artifact).toMatchObject({
      path,
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    });
    expect(evidence.normalized_result.build_info?.module_bytes_base64).toBe(
      fixture.moduleBytes.toString("base64"),
    );
  },
);
