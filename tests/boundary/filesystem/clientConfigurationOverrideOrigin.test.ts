import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { readClientConfigurationFiles } from "../../../src/application/ClientConfigurationFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { supportedClientRegistrationProfile } from "../../fixtures/clientRegistrationProfile.js";

it.each<{
  name: string;
  platform?: NodeJS.Platform;
  stored?: Record<string, string>;
  overrides?: Record<string, string>;
  reported: string;
  setting?: string;
  suppressed: string;
}>([
  {
    name: "case-folded Windows override for a missing file",
    platform: "win32",
    overrides: { rea_asar_max_header_bytes: "invalid-proposed-bytes" },
    reported: "launch overrides (REA_ASAR_MAX_HEADER_BYTES)",
    suppressed: "invalid-proposed-bytes",
  },
  {
    name: "malformed stored environment",
    stored: { HOPPER_LOADER_ARGS_JSON: "invalid-stored-bytes" },
    reported: "has an invalid REA server environment",
    suppressed: "invalid-stored-bytes",
  },
  {
    name: "invalid combination of otherwise valid settings",
    stored: { REA_GHIDRA_LANGUAGE_ID: "x86:LE:64:default" },
    overrides: { REA_GHIDRA_PROJECT_PATH: "/tmp/selected-project.gpr" },
    setting: "REA_GHIDRA_LANGUAGE_ID",
    reported: "check the client configuration and proposed launch overrides",
    suppressed: "/tmp/selected-project.gpr",
  },
  {
    name: "malformed stored environment beside valid overrides",
    stored: { HOPPER_LOADER_ARGS_JSON: "invalid-combined-bytes" },
    overrides: { REA_ASAR_MAX_HEADER_BYTES: "1024" },
    setting: "HOPPER_LOADER_ARGS_JSON",
    reported: "check the client configuration and proposed launch overrides",
    suppressed: "invalid-combined-bytes",
  },
])(
  "attributes $name without disclosing its value",
  async ({
    stored,
    overrides,
    reported,
    platform = HOST_PLATFORM.platform,
    setting = reported,
    suppressed,
  }) => {
    const root = await createTestTempDirectory("rea-config-diagnostic-origin-");
    const configPath = join(root, "client.json");
    if (stored !== undefined)
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { rea: { command: "rea", args: ["mcp"], env: stored } },
        }),
      );
    const result = await readClientConfigurationFiles(
      {
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        format: "json",
        configPath,
      },
      undefined,
      platform,
      overrides === undefined ? undefined : { writeOverrides: overrides },
    );
    if (result.ok) throw new Error("Expected rejected environment");
    expect(result.error.path).toBe(configPath);
    expect(result.error.detail).toContain(reported);
    expect(result.error.detail).toContain(setting);
    expect(result.error.detail).not.toContain(suppressed);
  },
);
