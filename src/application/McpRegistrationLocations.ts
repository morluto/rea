import { lstat } from "node:fs/promises";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import type { ClientRootContext } from "./ClientConfigRoots.js";
// Type-only: the client table imports project-location owners from here.
import type { SetupClient } from "./SupportedClients.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ClientInlineConfiguration } from "./ClientConfigurationDocument.js";

export interface McpRegistrationLocationContext {
  readonly home: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly setup: readonly SetupClient[];
  readonly resources: ArtifactResourceScope;
  readonly signal?: AbortSignal;
}

export interface McpRegistrationLocation {
  readonly configPath: string;
  /** Complete known file layers in native precedence; configPath alone grants write authority. */
  readonly configPaths?: readonly string[];
  readonly inlineConfiguration?: ClientInlineConfiguration;
}

export const selectedPath = (
  path: string,
  context: McpRegistrationLocationContext,
): string =>
  absoluteCallerPath(path, { cwd: context.cwd, platform: context.platform });

/** The client-root context of one registration selection. */
export const rootContext = ({
  home,
  platform,
  environment,
}: McpRegistrationLocationContext): ClientRootContext => ({
  home,
  platform,
  env: environment,
});

export const present = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw new ConfigurationError(
      `Cannot determine the registration location at ${path}. Repair its access or path before registering.`,
      { cause },
    );
  }
};

export const firstExisting = async (
  candidates: readonly string[],
  fallback: string,
): Promise<string> => {
  for (const candidate of candidates)
    if (await present(candidate)) return candidate;
  return fallback;
};

/** Fixed relative target precedence used by clients with a single project document. */
export const fixedProjectLocation =
  (candidates: readonly [string, ...string[]]) =>
  async (
    context: McpRegistrationLocationContext,
  ): Promise<McpRegistrationLocation> => {
    const paths = candidates.map((path) => selectedPath(path, context));
    return {
      configPath: await firstExisting(
        paths,
        selectedPath(candidates[0], context),
      ),
    };
  };
