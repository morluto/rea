import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  projectUnrealPakView,
  UNREAD_ENCRYPTED_INDEX_UNKNOWN,
} from "../../../src/domain/analysisView/unrealPakView.js";
import { UnrealPakProvider } from "../../../src/unreal/UnrealPakProvider.js";
import { createPakFixture } from "../../fixtures/unreal/pak.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const entriesPage = async (options: Parameters<typeof createPakFixture>[0]) => {
  const root = await createTestTempDirectory("rea-unreal-view-");
  const path = join(root, "Game.pak");
  await writeFile(path, createPakFixture(options).bytes);
  const provider = new UnrealPakProvider();
  const inspected = await provider.inspect({ path });
  await provider.close();
  if (!inspected.ok) throw new Error("fixture must decode");
  const projected = projectUnrealPakView(
    {
      evidenceId: "ev_" + "0".repeat(64),
      operation: "inspect_unreal_pak",
      normalizedResult: inspected.value,
      subject: null,
      limitations: [],
    },
    { kind: "unreal-pak", collection: "entries", offset: 0, limit: 8 } as never,
  );
  if (!projected.ok) throw new Error("projection must succeed");
  return projected.value as unknown as Record<string, unknown>;
};

it("tells an unread encrypted index apart from a decoded empty one", async () => {
  const encrypted = await entriesPage({ layout: "v11", encryptedIndex: true });
  const empty = await entriesPage({ layout: "v11", files: [] });
  expect(encrypted).toMatchObject({
    items: [],
    index_state: "encrypted",
    index_encrypted: true,
    unknowns: expect.arrayContaining([UNREAD_ENCRYPTED_INDEX_UNKNOWN]),
  });
  expect(empty).toMatchObject({
    items: [],
    index_state: "decoded",
    index_encrypted: false,
  });
  expect(empty.unknowns).not.toContain(UNREAD_ENCRYPTED_INDEX_UNKNOWN);
});
