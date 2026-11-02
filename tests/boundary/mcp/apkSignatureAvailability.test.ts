import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { sessionOutputSchemas } from "../../../src/contracts/toolOutputSchemaGroups.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { zipWith } from "../../fixtures/apkSignature/v1SignatureBlock.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reports explicit-path APK signature inspection available without an open target (#7316)", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("APK signature inspection must not start binary analysis");
  });
  const { client, close } = await createApplicationMcpHarness({ session });
  try {
    const status = async () => {
      const response = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(response.isError).not.toBe(true);
      const parsed = sessionOutputSchemas.binary_session.parse(
        response.structuredContent,
      ).result;
      expect(parsed.open).toBe(false);
      return expandToolAvailability(parsed.tool_availability);
    };
    const expectAvailable = async () =>
      expect(
        (await status()).find((tool) => tool.name === "inspect_apk_signature"),
      ).toMatchObject({
        available: true,
        reason: "available",
        remediation: null,
      });

    await expectAvailable();
    const path = join(
      await createTestTempDirectory("rea-apk-availability-"),
      "unsigned.zip",
    );
    await writeFile(
      path,
      await zipWith([{ name: "fixture.txt", data: "hello\n" }]),
    );
    const inspection = await client.callTool({
      name: "inspect_apk_signature",
      arguments: { path },
    });
    expect(inspection.isError).not.toBe(true);
    await expectAvailable();
  } finally {
    await close();
  }
});
