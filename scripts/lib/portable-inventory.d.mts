export function verifyPortableInventory(
  directory: string,
  files: readonly { readonly path: string }[],
): Promise<void>;
export function readPortableManifest(path: string): Promise<{
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
  readonly runtime?: unknown;
  readonly package?: unknown;
  readonly version?: unknown;
  readonly dependencies?: unknown;
}>;
export function hashPortableFile(
  path: string,
  expectedSize?: number,
): Promise<{ size: number; sha256: string }>;
