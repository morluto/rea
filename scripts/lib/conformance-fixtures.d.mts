export const LARGE_FIXTURE_COUNT: number;
export const HOPPER_C_ORACLE: Readonly<{
  mainProcedure: "main";
  entryProcedure: "rea_entry";
  branchProcedure: "rea_branch";
  leafProcedure: "rea_leaf";
  entryString: "REA_C_ENTRY";
  leafString: "REA_C_LEAF";
  globalName: "rea_c_global";
}>;
export function sha256(value: string | Uint8Array): string;
export function generateLargeFixture(count?: number): string;
export function sourceDigest(
  sources: readonly { readonly path: string; readonly content: string }[],
): string;
