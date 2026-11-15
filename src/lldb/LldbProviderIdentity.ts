/** Source-owned static provider identity and public operation names. */
export const LLDB_PROVIDER_IDENTITY = {
  id: "apple.lldb",
  name: "Apple LLDB",
  version: null,
} as const;

export interface LldbProviderIdentity {
  readonly id: typeof LLDB_PROVIDER_IDENTITY.id;
  readonly name: typeof LLDB_PROVIDER_IDENTITY.name;
  readonly version: string | null;
}
