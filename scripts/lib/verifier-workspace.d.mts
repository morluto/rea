export function withVerifierWorkspace<T>(
  operation: () => T | Promise<T>,
  commands: { close(): Promise<void> },
  workspace: () => string | undefined,
): Promise<T>;
