import { BinaryReader } from "../binaryContainer.js";

/** MS-SHLLINK 2.1: ShellLinkHeader size and LinkCLSID. */
export const SHELL_LINK_HEADER_BYTES = 76;
export const SHELL_LINK_CLSID = "00021401-0000-0000-C000-000000000046";

/** Format a little-endian Windows GUID as its canonical uppercase text. */
export const formatWindowsGuid = (
  reader: BinaryReader,
  offset: number,
): string => {
  const { bytes } = reader;
  const d1 = reader.u32(offset).toString(16).padStart(8, "0");
  const d2 = reader
    .u16(offset + 4)
    .toString(16)
    .padStart(4, "0");
  const d3 = reader
    .u16(offset + 6)
    .toString(16)
    .padStart(4, "0");
  const d4 = bytes.subarray(offset + 8, offset + 10).toString("hex");
  const d5 = bytes.subarray(offset + 10, offset + 16).toString("hex");
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toUpperCase();
};

/** Whether leading bytes declare a ShellLinkHeader: its size and LinkCLSID. */
export const hasWindowsShortcutHeader = (prefix: Buffer): boolean => {
  if (prefix.length < 20) return false;
  const reader = new BinaryReader(prefix, true, "windows-shortcut");
  return (
    reader.u32(0) === SHELL_LINK_HEADER_BYTES &&
    formatWindowsGuid(reader, 4) === SHELL_LINK_CLSID
  );
};
