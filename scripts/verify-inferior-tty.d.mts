import type { ChildProcessWithoutNullStreams } from "node:child_process";
export function openInferiorTty(options?: {
  readonly command?: string;
  readonly arguments?: readonly string[];
  readonly timeoutMs?: number;
}): Promise<{
  readonly helper: ChildProcessWithoutNullStreams;
  readonly path: string;
}>;
export function closeInferiorTty(
  helper: ChildProcessWithoutNullStreams,
): Promise<void>;
