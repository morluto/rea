import { expect, it } from "vitest";
import {
  androidNoteTypeName,
  coreNoteTypeName,
  elfObjectTypeName,
  gnuNoteTypeName,
  inspectElfNotesInputSchema,
  elfNotesSchema,
} from "./elfNotes.js";

it("maps ELF object, GNU, CORE, and Android note types without inventing unknown names", () => {
  expect(elfObjectTypeName(1)).toBe("relocatable");
  expect(elfObjectTypeName(2)).toBe("executable");
  expect(elfObjectTypeName(3)).toBe("shared");
  expect(elfObjectTypeName(4)).toBe("core");
  expect(elfObjectTypeName(99)).toBe("unknown");
  expect(gnuNoteTypeName(1)).toBe("gnu_abi_tag");
  expect(gnuNoteTypeName(3)).toBe("gnu_build_id");
  expect(gnuNoteTypeName(99)).toBe("unknown");
  expect(coreNoteTypeName(3)).toBe("core_prpsinfo");
  expect(coreNoteTypeName(1)).toBe("unknown");
  expect(androidNoteTypeName(1)).toBe("android_ident");
  expect(androidNoteTypeName(2)).toBe("unknown");
});

it("rejects extra caller arguments and admits an empty note inventory", () => {
  expect(
    inspectElfNotesInputSchema.safeParse({
      path: "/artifacts/app",
      extra: true,
    }).success,
  ).toBe(false);
  const report = elfNotesSchema.parse({
    artifact: {
      path: "/artifacts/app",
      sha256: "a".repeat(64),
      bytes: 512,
    },
    format: "elf64",
    byte_order: "little",
    machine: 62,
    type: 3,
    type_name: "shared",
    tables: [],
    entries: [],
    coverage: { status: "complete", examined_tables: 0, examined_entries: 0 },
    limitations: [
      "No PT_NOTE program header or SHT_NOTE section was declared.",
    ],
  });
  expect(report.tables).toEqual([]);
  expect(report.entries).toEqual([]);
});
