export interface PortableLockEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string | string[];
  cpu?: string | string[];
  libc?: string | string[];
}
export function portableDependencies(
  root: string,
  lock: { packages: Record<string, PortableLockEntry> },
  platform: string,
  architecture: string,
): Promise<{ path: string; version: string }[]>;
