import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  expectKeyedArchivePrototypeKeys,
  keyedArchivePrototypeKeyFixture,
} from "../../fixtures/keyedArchivePrototypeKeys.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "compiled CLI decodes formatted XML prototype keys",
  async ({ cli }) => {
    const fixture = await keyedArchivePrototypeKeyFixture();
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", fixture.path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    expectKeyedArchivePrototypeKeys(
      parseEvidence(output.json).normalized_result,
      fixture.digest,
    );
  },
);
