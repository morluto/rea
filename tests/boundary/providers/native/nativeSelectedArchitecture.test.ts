import { expect, it } from "vitest";
import { inspectMachoSchema } from "../../../../src/domain/nativeInspection.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

it("does not attribute the first universal slice's UUID and segments to the selected target", async () => {
  const singleSlice = await nativeFixture("otool-load.txt");
  const selected = new NativeFixtureRunner();
  const universal = new NativeFixtureRunner({
    "otool:-h": `${singleSlice}\n${singleSlice}`,
    dwarfdump:
      "UUID: AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA (x86_64) fixture\nUUID: 01234567-89AB-CDEF-0123-456789ABCDEF (arm64) fixture\n",
  });
  const client = new NativeMacOSProvider(
    {
      async run(tool, arguments_) {
        const isSelected =
          arguments_.includes("arm64") || arguments_.includes("--arch=arm64");
        return (isSelected ? selected : universal).run(tool, arguments_);
      },
    },
    "darwin",
  ).createClient(nativeMachoTarget("/owned/universal"));
  const result = await client.execute("inspect_macho", {});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.result).toMatchObject({
    uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
    architectures: { total: 2 },
  });
  const normalized = inspectMachoSchema.parse(result.value.result);
  expect(
    normalized.segments.items.filter((segment) => segment.name === "__TEXT"),
  ).toHaveLength(1);
  expect(JSON.stringify(normalized)).not.toContain(
    "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
  );
});
