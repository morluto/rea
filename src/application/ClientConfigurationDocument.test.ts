import { describe, expect, it } from "vitest";

import { clientConfigurationValuesEqual } from "./ClientConfigurationDocument.js";

describe("client configuration comparison", () => {
  it("ignores TOML parser object prototypes and key order", () => {
    const parsedEnvironment = {
      HOPPER_LAUNCHER_PATH: "/opt/rea/node",
    };
    const parsedRegistration = {
      env: parsedEnvironment,
      startup_timeout_sec: 30,
      args: ["mcp"],
      command: "/opt/rea/bin/rea",
    };
    Object.setPrototypeOf(parsedEnvironment, null);
    Object.setPrototypeOf(parsedRegistration, null);

    expect(
      clientConfigurationValuesEqual(parsedRegistration, {
        command: "/opt/rea/bin/rea",
        args: ["mcp"],
        startup_timeout_sec: 30,
        env: { HOPPER_LAUNCHER_PATH: "/opt/rea/node" },
      }),
    ).toBe(true);
  });

  it("still detects configuration value changes", () => {
    expect(
      clientConfigurationValuesEqual(
        { startup_timeout_sec: 30 },
        { startup_timeout_sec: 15 },
      ),
    ).toBe(false);
  });
});
