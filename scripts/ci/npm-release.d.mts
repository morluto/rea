import type { NpmReleaseState } from "./npm-release-state.mjs";

export function readNpmRelease(
  version: string,
  request?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<NpmReleaseState>;
export function stableUpdateVersion(
  version: string,
  published: NpmReleaseState,
): string;
export function waitForNpmRelease(
  version: string,
  lookup?: (version: string, signal: AbortSignal) => Promise<NpmReleaseState>,
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<Extract<NpmReleaseState, { status: "published" }>>;
