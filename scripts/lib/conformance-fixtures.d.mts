export const LARGE_FIXTURE_COUNT: number;
export function sha256(value: string | Uint8Array): string;
export function generateLargeFixture(count?: number): string;
export function sourceDigest(
  sources: readonly { readonly path: string; readonly content: string }[],
): string;
