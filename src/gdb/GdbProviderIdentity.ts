import { gdbMiConstText, parseGdbMiStreamRecord } from "./GdbMiRecord.js";

/** Source-owned static provider identity and public operation names. */
export const GDB_PROVIDER_IDENTITY = {
  id: "gnu.gdb",
  name: "GNU GDB",
  version: null,
} as const;

/** Provider identity with the version this GDB reported, or null when unknown. */
export interface GdbProviderIdentity {
  readonly id: typeof GDB_PROVIDER_IDENTITY.id;
  readonly name: typeof GDB_PROVIDER_IDENTITY.name;
  readonly version: string | null;
}

/**
 * Read the GDB version from the `-gdb-version` reply's stream records. The
 * first console record is `GNU gdb (<package>) <version>`; any other first
 * console record, or one that is not strict UTF-8, leaves it unknown.
 */
export const gdbReportedVersion = (
  records: readonly string[],
): string | null => {
  const banner = records
    .map(parseGdbMiStreamRecord)
    .find((record) => record.ok && record.value.kind === "console");
  const text = banner?.ok ? gdbMiConstText(banner.value.value) : undefined;
  const line = text?.split("\n", 1)[0]?.trim() ?? "";
  if (!line.startsWith("GNU gdb ")) return null;
  const version = line.slice(line.lastIndexOf(" ") + 1);
  return /^\d/u.test(version) ? version : null;
};
