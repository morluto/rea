export function executePortableCommand(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly windowsVerbatimArguments?: boolean;
  },
): Promise<{ readonly stdout: string; readonly stderr: string }>;

export function executePortableBatchHelp(
  directory: string,
  options: Parameters<typeof executePortableCommand>[2],
): ReturnType<typeof executePortableCommand>;
