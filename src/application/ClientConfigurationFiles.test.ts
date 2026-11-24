import { expectResultValue } from "../../tests/support/expectResultValue.js";
import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import { inlineRegistrationOverride } from "./ClientConfigurationFiles.js";

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
    ...expectResultValue(
      parseClientConfiguration(
        JSON.stringify({ mcp: { rea: kilo(file) } }),
        "kilo",
      ),
    ),
    sourcePath: client.configPath,
  },
  {
    ...expectResultValue(
      parseClientConfiguration(
        JSON.stringify({ mcp: { rea: { environment: inline } } }),
        "kilo",
      ),
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
