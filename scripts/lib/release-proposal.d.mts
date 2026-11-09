export function applyReleasePleasePatch(directory?: string): Promise<void>;

export function describeReleaseProposalError(error: unknown): string;

export function releaseProposalSearchDepth(
  run: (command: string, args: string[]) => Promise<string>,
  sourceSha: string,
): Promise<number>;
