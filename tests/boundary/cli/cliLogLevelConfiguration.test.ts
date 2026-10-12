import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

for (const level of ["loud", "INFO"])
  cliTest(
    `reports REA_LOG_LEVEL=${level} as invalid configuration`,
    async ({ cli }) => {
      for (const arguments_ of [["doctor", "--json"], ["--help"]]) {
        const result = await cli.run({
          arguments: arguments_,
          environment: { REA_LOG_LEVEL: level },
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          'REA configuration is invalid: REA_LOG_LEVEL: Invalid option: expected one of "trace"|"debug"|"info"|"warn"|"error"|"fatal"|"silent".\n',
        );
      }
    },
  );
