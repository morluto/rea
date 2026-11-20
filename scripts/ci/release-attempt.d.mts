export function recordReleaseAttempt(
  api: (path: string, body?: { ref: string; sha: string }) => Promise<Response>,
  source: string,
  parent: string,
  decision: "abandon" | "publish",
): Promise<void>;
export function inspectGithubRelease(
  api: (path: string) => Promise<Response>,
  tag: string,
  source: string,
): Promise<boolean>;
export function verifyFrozenReleaseBranch(
  api: (path: string) => Promise<Response>,
  branch: string,
  source: string,
): Promise<void>;
export function githubApi(
  repository: string,
  token: string,
): (
  path: string,
  body?: Record<string, string>,
  method?: string,
) => Promise<Response>;
