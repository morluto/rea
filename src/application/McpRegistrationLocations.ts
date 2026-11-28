import { lstat } from "node:fs/promises";

import { ConfigurationError } from "../domain/configurationErrors.js";
import type { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { isEnoentError } from "./ClientConfigPath.js";
import type { ClientRootContext } from "./ClientConfigRoots.js";
// Type-only: the client table imports project-location owners from here.
import type { SetupClient } from "./SupportedClients.js";
import type { ArtifactResourceScope } from "../resources/index.js";
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

export type McpRegistrationLocationResult = Result<
  McpRegistrationLocation,
  ConfigurationError | AnalysisCancelledError
>;

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

export const present = async (
  path: string,
): Promise<Result<boolean, ConfigurationError>> => {
  try {
    await lstat(path);
    return ok(true);
  } catch (cause: unknown) {
    if (isEnoentError(cause)) return ok(false);
    return err(
      new ConfigurationError(
        `Cannot determine the registration location at ${path}. Repair its access or path before registering.`,
        { cause },
      ),
    );
  }
};

/** Fixed relative target precedence used by clients with a single project document. */
export const fixedProjectLocation =
  (candidates: readonly [string, ...string[]]) =>
  async (
    context: McpRegistrationLocationContext,
  ): Promise<McpRegistrationLocationResult> => {
    for (const candidate of candidates) {
      const configPath = selectedPath(candidate, context);
      const exists = await present(configPath);
      if (!exists.ok) return exists;
      if (exists.value) return ok({ configPath });
    }
    return ok({ configPath: selectedPath(candidates[0], context) });
  };
