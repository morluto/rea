import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

const targets = async (): Promise<readonly [string, string]> => {
  const directory = await createTestTempDirectory("bb-session-");
  const first = join(directory, "first.hop");
  const second = join(directory, "second.hop");
  await writeFile(first, "one");
  await writeFile(second, "two");
  return [first, second];
};

describe("binary session", () => {
  it("does not start a replacement after the active provider cleanup is unconfirmed", async () => {
    const [first, second] = await targets();
    const cleanupError = new ProviderCleanupError(
      "fixture",
      ["fixture-document"],
      { reason: "shutdown acknowledgement missing" },
    );
    let created = 0;
    const session = createTestBinarySession(() => {
      created += 1;
      return {
        execute: () => Promise.resolve(ok(null)),
        closeWithOutcome: () => Promise.resolve(err(cleanupError)),
        close: () => Promise.resolve(),
      };
    });
    expect((await session.open(first)).ok).toBe(true);

    expect(await session.open(second)).toEqual(err(cleanupError));
    expect(created).toBe(1);
    expect(session.status()).toMatchObject({ open: false });
  });
});
