import { expect, it } from "vitest";
import { sectionRelocations } from "./ElfInitializerSymbols.js";
import { InitializerNotes } from "./initializerNotes.js";
import type { NativeSection } from "../metadata/NativeSectionDirectory.js";

const section = (changes: Partial<NativeSection> = {}): NativeSection => ({
  index: 0,
  name: null,
  name_state: "unavailable",
  header_offset: 0,
  offset: 0n,
  size: 24n,
  address: 0n,
  type: 1,
  flags: 0n,
  link: 0,
  info: 0,
  entry_size: 0n,
  alignment: 1n,
  file_backed: true,
  compressed: false,
  ...changes,
});

it.each([
  ["compressed", { compressed: true }],
  ["unexpected record size", { entry_size: 8n }],
  ["unreadable target", {}],
] as const)(
  "does not certify raw initializer values for %s relocations with an unknown target",
  async (_case, changes) => {
    const target = section();
    const unrelated = section();
    const relocation = section({ type: 4, info: 42, ...changes });
    const result = await sectionRelocations({
      bytes: Buffer.alloc(32),
      bits: 64,
      little: true,
      machine: 62,
      sections: [target, unrelated, relocation],
      relocatable: true,
      wanted: [{ va: 0n, sectionIndex: 0 }],
      tables: new Map(),
      notes: new InitializerNotes(),
      fileOffset: () => null,
    });
    expect(result.complete).toBe(false);
  },
);

it("keeps an unrelated known section from invalidating a wanted slot", async () => {
  const sections = [
    section(),
    section(),
    section({ type: 4, info: 1, compressed: true }),
  ];
  const result = await sectionRelocations({
    bytes: Buffer.alloc(32),
    bits: 64,
    little: true,
    machine: 62,
    sections,
    relocatable: true,
    wanted: [{ va: 0n, sectionIndex: 0 }],
    tables: new Map(),
    notes: new InitializerNotes(),
    fileOffset: () => null,
  });
  expect(result.complete).toBe(true);
});

it.each([true, false])(
  "keeps coverage unknown for zero sh_info with compressed=%s",
  async (compressed) => {
    const sections = [
      section({ type: 0, file_backed: false }),
      section(),
      section({ type: 4, info: 0, compressed }),
    ];
    const result = await sectionRelocations({
      bytes: Buffer.alloc(32),
      bits: 64,
      little: true,
      machine: 62,
      sections,
      relocatable: true,
      wanted: [{ va: 0n, sectionIndex: 1 }],
      tables: new Map(),
      notes: new InitializerNotes(),
      fileOffset: () => null,
    });
    expect(result.complete).toBe(false);
  },
);
