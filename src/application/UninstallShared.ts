import type { ClientConfigurationPublication } from "./ClientConfigurationPublication.js";

export interface ManagedPathStats {
  readonly uid?: number;
  isFile?(): boolean;
  isDirectory?(): boolean;
  isSymbolicLink(): boolean;
}

/** Injectable filesystem operations used to prove uninstall failure recovery. */
export interface UninstallFileSystem {
  readText(path: string): Promise<string>;
  readRegularText?(path: string): Promise<string>;
  /** Preserve the first backup; reject an existing destination with EEXIST. */
  copy(source: string, destination: string): Promise<void>;
  publishConfiguration(
    path: string,
    contents: string,
    original: string,
  ): Promise<
    Pick<
      ClientConfigurationPublication,
      "path" | "verify" | "assertCurrent" | "restore"
    >
  >;
  stat(path: string): Promise<ManagedPathStats>;
  realpath?(path: string): Promise<string>;
  remove(path: string, recursive?: boolean): Promise<void>;
  /** Remove a directory only if it is empty; a non-empty one is kept. */
  removeEmptyDirectory?(path: string): Promise<void>;
}

/** One completed or refused action, preserving its candidate configuration path. */
export interface UninstallAction {
  readonly status: "removed" | "retained" | "skipped" | "failed";
  readonly detail: string;
  readonly configuration_path?: string;
}

/** One client summary with its constituent actions when multiple paths apply. */
export interface UninstallItem extends UninstallAction {
  readonly name: string;
  readonly actions?: readonly UninstallAction[];
}

export const item = (
  name: string,
  status: UninstallItem["status"],
  detail: string,
): UninstallItem => ({ name, status, detail });

export const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
