import { describe, expect, it } from "vitest";

import { createDoctorHostFixture as host } from "./Doctor.fixture.js";
import { runDoctor } from "./Doctor.js";

describe("doctor runtime executable diagnostics", () => {
  it("reports a broken shadowed Node candidate without hiding the healthy launcher", async () => {
    const result = await runDoctor(
      undefined,
      host({
        runtimeExecutables: () =>
          Promise.resolve({
            launcher_node: "/healthy/node",
            candidates: [
              {
                tool: "node",
                lexical_path: "/healthy/node",
                canonical_path: "/healthy/node",
                path_index: null,
                selection: "rea-launcher",
                version: "v24.18.0",
                healthy: true,
                failure: null,
              },
              {
                tool: "node",
                lexical_path: "/opt/homebrew/bin/node",
                canonical_path: "/opt/homebrew/Cellar/node/25.2.1/bin/node",
                path_index: 2,
                selection: "path-shadowed",
                version: null,
                healthy: false,
                failure: {
                  code: "runtime_dynamic_library_missing",
                  exit_code: 134,
                  signal: null,
                  dependency:
                    "/opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib",
                  stderr: "dyld: Library not loaded",
                },
              },
            ],
          }),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity?.runtime_executables).toMatchObject({
      launcher_node: "/healthy/node",
      candidates: [
        { healthy: true, selection: "rea-launcher" },
        {
          healthy: false,
          failure: { code: "runtime_dynamic_library_missing" },
        },
      ],
    });
    expect(
      result.checks.find(({ name }) => name === "node-toolchains"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      remediation: expect.stringContaining("Do not create"),
    });
  });
});
