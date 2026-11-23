import { expect, it } from "vitest";
import { join } from "node:path";
import { evmInterfaceModule } from "../../src/composition/evm.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("keeps one EVM inspection service available to admit requests after another closes", async () => {
  const directory = await createTestTempDirectory("rea-evm-services-");
  const input = { path: join(directory, "fixture.hex"), encoding: "hex" };
  const host = { platform: "darwin", architecture: "arm64" } as const;
  const first = evmInterfaceModule.create({}, host);
  const second = evmInterfaceModule.create({}, host);
  try {
    const beforeClose = await second.inspect(input);
    expect(beforeClose).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        reason: expect.stringContaining("Linux x64"),
      },
    });
    await first.close();
    expect(await first.inspect(input)).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        reason: expect.stringContaining("closing"),
      },
    });
    expect(await second.inspect(input)).toEqual(beforeClose);
  } finally {
    await first.close();
    await second.close();
  }
});
