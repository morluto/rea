import {
  readElfTableDeclarations,
  type ElfDeclarationRead,
  type ElfTableDeclarations,
} from "./elfDeclaredRanges.js";
import {
  readElfSectionHeader,
  type ElfSectionHeader,
} from "./elfSectionHeader.js";
import { err, type Result } from "./result.js";

/**
 * Visit every declared section header in reads of at most 64 KiB from the
 * caller's descriptor. The visitor returns a reason to stop with that failure.
 */
export function* visitElfSectionHeaders(
  prefix: Buffer,
  fileSize: number,
  visit: (
    section: ElfSectionHeader,
    index: number,
    tables: ElfTableDeclarations,
  ) => string | undefined,
): Generator<ElfDeclarationRead, Result<ElfTableDeclarations, string>, Buffer> {
  const declarations = yield* readElfTableDeclarations(prefix, fileSize);
  if (!declarations.ok) return declarations;
  const { header, sections } = declarations.value;
  const little = header.byteOrder === "little";
  const perRead = Math.max(1, Math.floor((64 * 1024) / sections.width));
  for (let index = 0; index < sections.count; index += perRead) {
    const count = Math.min(perRead, sections.count - index);
    const size = count * sections.width;
    const bytes = yield {
      offset: Number(sections.offset) + index * sections.width,
      size,
    };
    if (bytes.length !== size) return err("truncated ELF section header table");
    for (let item = 0; item < count; item += 1) {
      const at = item * sections.width;
      const parsed = readElfSectionHeader(
        bytes.subarray(at, at + sections.width),
        header.elfClass,
        little,
      );
      if (!parsed.ok) return err(parsed.error.message);
      const failure = visit(parsed.value, index + item, declarations.value);
      if (failure !== undefined) return err(failure);
    }
  }
  return declarations;
}
