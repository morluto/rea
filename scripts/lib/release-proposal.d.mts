export function applyReleasePleasePatch(directory?: string): Promise<void>;

export function describeReleaseProposalError(error: unknown): string;

export function releaseProposalSearchDepth(
  run: (command: string, args: string[]) => Promise<string>,
  sourceSha: string,
): Promise<number>;

export function createReleaseProposal<T>(
  run: (command: string, args: string[]) => Promise<string>,
  context: {
    repository: string;
    sourceSha: string;
    targetBranch: string;
    eventName: string | undefined;
  },
  loadManifest: (depth: number) => Promise<{
    createPullRequests(): Promise<Array<T | undefined>>;
  }>,
): Promise<
  | { kind: "release-merge"; pullRequest: number }
  | { kind: "proposal"; pullRequests: T[] }
>;
