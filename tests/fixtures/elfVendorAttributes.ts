import { write32 } from "../../src/native/BinaryInteger.fixture.js";

export const u32 = (value: number, little: boolean): number[] => {
  const bytes = Buffer.alloc(4);
  write32(bytes, 0, value, little);
  return [...bytes];
};

/** Encode one ELF vendor subsection holding a single scoped attribute list. */
export const vendorAttributeSection =
  (defaultVendor: string) =>
  (
    attributes: readonly number[],
    {
      little = true,
      vendor = defaultVendor,
      scope = 1,
    }: {
      readonly little?: boolean;
      readonly vendor?: string;
      readonly scope?: number;
    } = {},
  ): Buffer => {
    const scoped = [
      scope,
      ...u32(1 + 4 + attributes.length, little),
      ...attributes,
    ];
    const name = [...Buffer.from(vendor, "latin1"), 0];
    return Buffer.from([
      0x41,
      ...u32(4 + name.length + scoped.length, little),
      ...name,
      ...scoped,
    ]);
  };
