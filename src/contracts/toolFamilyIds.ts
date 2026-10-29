/**
 * Selectable tool-family ids in catalog order.
 *
 * Kept separate from the contract definitions so startup configuration can
 * validate `REA_MCP_TOOL_FAMILIES` without loading the canonical schema graph
 * that the deferred MCP runtime deliberately avoids.
 */
export const TOOL_FAMILY_IDS = [
  "direct",
  "enhanced",
  "native",
  "artifact",
  "managed",
  "firmware",
  "android",
  "pcap",
  "flutter",
  "frida",
  "apktool",
  "jeb",
  "adb",
  "browser",
  "electron",
  "javascript-runtime",
  "application",
  "session",
] as const;

export type ToolFamilyId = (typeof TOOL_FAMILY_IDS)[number];

/** Whether a parsed selection value names a published tool family. */
export const isToolFamilyId = (value: string): value is ToolFamilyId =>
  (TOOL_FAMILY_IDS as readonly string[]).includes(value);
