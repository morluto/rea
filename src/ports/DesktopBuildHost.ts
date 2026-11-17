import type { execFileOutput } from "../process/ExecFileOutput.js";
import type { ArtifactResourceScope } from "../resources/index.js";

/**
 * The desktop build host contract: what doctor and `rea setup --desktop-build`
 * read from, and ask of, the host that runs Docker, uv and agentenv. The
 * desktop provider implements it; application workflows consume it.
 */

/** Setting names a registration does not carry as the value selected here. */
export interface RecordedProviderSettings {
  /** Selected here and absent from the registration's recorded environment. */
  readonly unrecorded: readonly string[];
  /** Recorded with text other than the value selected here. */
  readonly differing: readonly string[];
  /** Recorded as an expression, or in a map REA could not read. */
  readonly unresolved: readonly string[];
  /** Recorded with a value the caller owns, as an archive setup packed for another version. */
  readonly owned?: readonly string[];
}

/** Whether a recorded value is the caller's own, which it may replace; the value never leaves the reader. */
export type OwnedProviderSetting = (name: string, value: string) => boolean;

/**
 * The registration facts a desktop build host reads for one client: setting
 * names only, never recorded values. Client registration status satisfies it.
 */
export interface DesktopBuildRegistration {
  readonly client: string;
  /** Empty when the client has no usable registration. */
  readonly command: readonly string[];
  readonly provider_settings?: RecordedProviderSettings;
}

/** Reads each selected client's registration against the settings selected here. */
export type DesktopBuildRegistrationReader = (
  selectedClientIds?: readonly string[],
  providerSettings?: Readonly<Record<string, string>>,
  ownedProviderSetting?: OwnedProviderSetting,
  observeProviderSetting?: (
    client: string,
    name: string,
    value: string,
  ) => void,
) => Promise<readonly DesktopBuildRegistration[]>;

/** How a build setting's program was found: set in the environment, or on PATH. */
export type DesktopBuildCommand =
  | {
      readonly status: "found";
      readonly path: string;
      readonly source: "environment" | "path";
    }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly value: string };

/** What a desktop build host has, read without changing anything. */
export interface DesktopBuildFacts {
  readonly ps: { readonly found: boolean; readonly detail: string };
  readonly docker: DesktopBuildCommand;
  readonly daemon:
    | { readonly status: "reachable"; readonly rootDirectory: string }
    | {
        readonly status: "permission_denied" | "unreachable";
        readonly detail: string;
      }
    | { readonly status: "unchecked" };
  readonly disk:
    | { readonly path: string; readonly freeBytes: number }
    | { readonly path: string; readonly error: string };
  readonly agentEnv: DesktopBuildCommand & {
    readonly version?: string | undefined;
  };
  readonly archive: {
    readonly path: string;
    readonly source: "environment" | "cache";
    readonly status: "current" | "missing" | "stale" | "unknown";
    readonly detail?: string;
  };
  /** Each considered client's registration, by setting names only. */
  readonly registrations: readonly {
    readonly client: string;
    readonly registered: boolean;
    readonly unrecorded: readonly string[];
    readonly unresolved: readonly string[];
    readonly differing?: readonly string[];
    readonly unchecked?: readonly string[];
    /** Version check of this client's recorded runner, without the recorded path. */
    readonly runner?: {
      readonly status: "current" | "stale" | "invalid" | "unknown";
      readonly version?: string;
    };
  }[];
  /** Build settings this terminal's environment sets. */
  readonly environmentSettings: readonly string[];
  /** Where a solve endpoint is configured; null means its configuration is unknown. */
  readonly solveEndpoint: string | null | undefined;
  /** Names of agentenv sandbox containers; undefined when Docker was not reachable. */
  readonly leftoverContainers: readonly string[] | undefined;
}

/** What a facts reader gets from doctor: its environment, bounded runner and registration reader. */
export interface DesktopBuildFactsInput {
  readonly signal: AbortSignal;
  readonly resources: ArtifactResourceScope;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly platform: NodeJS.Platform;
  readonly run: typeof execFileOutput;
  readonly clientIds: readonly string[];
  readonly registrations: (
    clientIds: readonly string[] | undefined,
    settings: Readonly<Record<string, string>>,
    owned?: undefined,
    observe?: (client: string, name: string, value: string) => void,
  ) => Promise<readonly DesktopBuildRegistration[]>;
}

/** What setup reads from a host before it plans a desktop build setup. */
export interface DesktopBuildSetupFacts {
  /** Each build setting resolved to an absolute path; absent when none resolves. */
  readonly settings: Readonly<Record<string, string>>;
  /** Settings the caller's environment selected, which setup records as they are. */
  readonly selected: readonly string[];
  readonly archive: string;
  readonly archivePacked: boolean;
  /** Why this REA cannot pack its runtime, when it cannot. */
  readonly packBlocker?: string;
  readonly agentEnvVersion?: string | undefined;
  /** uv on PATH and the agent-env its tool install places. */
  readonly uv?: { readonly path: string; readonly agentEnv: string };
  /** Per client, the build settings its registration already records with a value of its own. */
  readonly recorded: Readonly<Record<string, readonly string[]>>;
}

/** Effects `rea setup --desktop-build` needs from its host. */
export interface DesktopBuildSetupHost {
  facts(clientIds: readonly string[]): Promise<DesktopBuildSetupFacts>;
  /** Pack this REA as the build-computer runtime; the reason when it failed. */
  packRuntime(
    archive: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  /** Install the pinned agentenv-framework with uv; the reason when it failed. */
  installAgentenv(
    uv: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

/** Creates the desktop build host effects bound to a caller's cleanup scope. */
export type DesktopBuildSetupHostFactory = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  registrations: DesktopBuildRegistrationReader | undefined,
  resources: ArtifactResourceScope,
) => DesktopBuildSetupHost;
