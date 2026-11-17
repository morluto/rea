import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import {
  inlineRegistrationOverride,
  readEffectiveClientRegistrationConfiguration,
} from "./ClientConfigurationFiles.js";
import { clientRegistrationEnvironmentDetails } from "./ClientRegistrationEnvironment.js";
import { supportedClients } from "./SupportedClients.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const client = { configPath: "/home/u/.config/kilo/kilo.json" };
const command = ["/usr/bin/node", "/opt/rea/cli.js", "mcp"];
const kilo = (environment: Record<string, string>) => ({
  type: "local",
  command,
  environment,
});

const sources = (
  file: Record<string, string>,
  inline: Record<string, string>,
) => [
  {
    ...parseClientConfiguration(
      JSON.stringify({ mcp: { rea: kilo(file) } }),
      "kilo",
    ),
    sourcePath: client.configPath,
  },
  {
    ...parseClientConfiguration(
      JSON.stringify({ mcp: { rea: { environment: inline } } }),
      "kilo",
    ),
    inlineOrigin: "KILO_CONFIG_CONTENT" as const,
  },
];

describe("inlineRegistrationOverride", () => {
  it("treats a Windows environment name in another case as the same name", () => {
    const desired = kilo({ PATH: "C:\\bin" });
    expect(
      inlineRegistrationOverride(
        client,
        sources({ PATH: "C:\\bin" }, { Path: "C:\\bin" }),
        desired,
        "win32",
      ),
    ).toBeUndefined();
    expect(
      inlineRegistrationOverride(
        client,
        sources({ PATH: "C:\\bin" }, { Path: "C:\\other" }),
        desired,
        "win32",
      ),
    ).toBe("KILO_CONFIG_CONTENT");
  });

  it("keeps POSIX environment names case-sensitive", () => {
    expect(
      inlineRegistrationOverride(
        client,
        sources({ PATH: "/bin" }, { Path: "/bin" }),
        kilo({ PATH: "/bin" }),
        "linux",
      ),
    ).toBe("KILO_CONFIG_CONTENT");
  });
});

it("diagnoses readable invalid settings without admitting them for setup", async () => {
  const home = await createTestTempDirectory("rea-registration-observation-");
  const selected = supportedClients(home, "linux", {}).find(
    (client) => client.name === "opencode",
  );
  if (selected === undefined)
    throw new Error("Missing OpenCode fixture client");
  await mkdir(dirname(selected.configPath), { recursive: true });
  const values = {
    REA_JEB_MCP_URL: "http://127.0.0.1:9999/mcp",
    REA_JEB_MCP_TIMEOUT_MS: "invalid",
  };
  await writeFile(
    selected.configPath,
    JSON.stringify({
      mcp: { rea: { type: "local", command, environment: values } },
    }),
  );
  expect(
    (
      await readEffectiveClientRegistrationConfiguration(
        selected,
        undefined,
        "linux",
      )
    ).ok,
  ).toBe(false);
  const observed = await readEffectiveClientRegistrationConfiguration(
    selected,
    undefined,
    "linux",
    "diagnostic",
  );
  if (!observed.ok) throw new Error(observed.error.detail);
  const details = clientRegistrationEnvironmentDetails(
    observed.value.document,
    selected,
    "linux",
    {},
    "diagnostic",
  );
  expect(details).toMatchObject({
    ok: true,
    value: { values, timeoutInputs: undefined },
  });
  expect(
    clientRegistrationEnvironmentDetails(
      observed.value.document,
      selected,
      "linux",
    ).ok,
  ).toBe(false);
});

it.each([
  { CALLER_SETTING: "rejected-value\0tail" },
  { ["CALLER\0SETTING"]: "rejected-value" },
  { ["CALLER=SETTING"]: "rejected-value" },
])(
  "refuses unrepresentable environment entries even in diagnostic mode: %j",
  (values) => {
    const document = parseClientConfiguration(
      JSON.stringify({ mcp: { rea: kilo(values) } }),
      "opencode",
    );
    const observed = clientRegistrationEnvironmentDetails(
      document,
      undefined,
      "linux",
      {},
      "diagnostic",
    );
    expect(observed.ok).toBe(false);
    if (observed.ok) throw new Error("Expected environment-entry refusal");
    expect(observed.error.settings).toHaveLength(1);
    expect(JSON.stringify(observed.error)).not.toContain("rejected-value");
  },
);
