import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  {
    command: "inspect-sqlite-database",
    field: "rowLimit",
    flag: "--row-limit",
    accepted: ["1", "0001", "9007199254740991"],
    rejected: ["0", "0000", "9007199254740992"],
  },
  {
    command: "inspect-byte-entropy",
    field: "blockSize",
    flag: "--block-size",
    accepted: ["256", "00256", "65536"],
    rejected: ["0", "255", "65537", "0065537"],
  },
])(
  "advertises and enforces $command decimal bounds",
  async (entry, { cli }) => {
    const discovery = await cli.run({
      arguments: [entry.command, "--schema", "--format", "json"],
    });
    expect(discovery.exitCode).toBe(0);
    const schema = JSON.parse(discovery.stdout).options.properties[entry.field];
    const validate = new Ajv2020({ strict: false }).compile(schema);
    for (const token of entry.accepted)
      expect(validate(token), token).toBe(true);
    for (const token of entry.rejected) {
      expect(validate(token), token).toBe(false);
      const execution = await cli.run({
        arguments: [
          entry.command,
          "/nonexistent/decimal-bounds-target",
          `${entry.flag}=${token}`,
          "--format",
          "json",
        ],
      });
      expect(execution.exitCode).toBe(1);
      expect(JSON.parse(execution.stdout)).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: expect.arrayContaining([
          expect.objectContaining({ path: entry.field }),
        ]),
      });
    }
  },
);
