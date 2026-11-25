import { zstdCompressSync } from "node:zlib";
import { compressedElfNoteFixture } from "../../../src/native/elf/ElfNotes.fixture.js";

/** Two ordinary frames encode the original ELF note fixture's names. */
export const elfFrameAllowanceFixture = () => {
  const section = ".note.gnu.build-id";
  return compressedElfNoteFixture(
    64,
    true,
    2,
    section,
    Buffer.concat([
      zstdCompressSync(Buffer.from(`\0${section}\0`)),
      zstdCompressSync(Buffer.from(".shstrtab\0")),
    ]),
  );
};
