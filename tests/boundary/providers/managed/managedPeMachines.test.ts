import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { ManagedStaticProvider } from "../../../../src/dotnet/ManagedStaticProvider.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

// ReadyToRun images compiled for a non-Windows OS store the machine XORed
// with IMAGE_FILE_MACHINE_NATIVE_OS_OVERRIDE from CoreCLR's pedecoder.h.
it.each([
  ["ARM", 0x01c0, "arm", false, false],
  ["THUMB", 0x01c2, "arm", false, false],
  ["ARMNT", 0x01c4, "arm", false, true],
  ["Linux x86", 0x014c ^ 0x7b79, "x86", true, false],
  ["Linux ARM", 0x01c4 ^ 0x7b79, "arm", true, true],
  ["Apple ARM", 0x01c4 ^ 0x4644, "arm", true, false],
  ["FreeBSD x86", 0x014c ^ 0xadc4, "x86", true, false],
] as const)(
  "resolves and inspects the %s managed PE machine",
  async (_label, machine, architecture, readyToRun, inspectBoundaries) => {
    const bytes = buildManagedPeFixture({ cliFlags: 0, readyToRun });
    bytes.writeUInt16LE(machine, bytes.readUInt32LE(0x3c) + 4);
    const directory = await createTestTempDirectory("rea-managed-machine-");
    const path = join(directory, "fixture.dll");
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value).toMatchObject({
      kind: "executable",
      format: "pe",
      architecture,
      managed: true,
    });

    const client = new ManagedStaticProvider().createClient(parsed.value);
    const subject = { path, sha256: parsed.value.sha256 };
    try {
      const artifact = await client.execute("inspect_managed_artifact", {});
      if (!artifact.ok) throw artifact.error;
      expect(artifact.value).toMatchObject({
        subject,
        result: {
          pe: {
            machine,
            architecture,
            cli: { ready_to_run_signature: readyToRun },
          },
          classification: { managed_architecture: architecture },
          module: { name: "Fixture.dll" },
        },
      });
      if (inspectBoundaries) {
        const members = await client.execute("inspect_managed_members", {});
        if (!members.ok) throw members.error;
        expect(members.value).toMatchObject({
          subject,
          result: {
            module: { name: "Fixture.dll" },
            methods: [{ token: "0x06000001", name: "Main" }],
          },
        });

        const native = await client.execute(
          "inspect_managed_native_boundaries",
          {},
        );
        if (!native.ok) throw native.error;
        expect(native.value).toMatchObject({
          subject,
          result: {
            module: { name: "Fixture.dll" },
            cli_native: { ready_to_run_signature: readyToRun },
          },
        });
      }
    } finally {
      await client.close();
    }
  },
);
