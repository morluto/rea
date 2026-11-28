export interface PortableVerifierCommands {
  exec(
    command: string,
    arguments_: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeout?: number;
      readonly maxBuffer?: number;
      readonly windowsVerbatimArguments?: boolean;
    },
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export function executePortableCommand(
  commands: PortableVerifierCommands,
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
  commands: PortableVerifierCommands,
  directory: string,
  options: Parameters<typeof executePortableCommand>[3],
): ReturnType<typeof executePortableCommand>;
