import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { Logger } from "../logger.js";
import type { ToolKind } from "../contracts/toolContractTypes.js";
import type { CreateServerOptions } from "./createServer.js";
import type { ProcessCaptureElicitation } from "./ProcessCaptureElicitation.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";

interface HydratedToolContext {
  readonly logger: Logger;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
  readonly availabilityPolicy: (() => SessionAvailability) | undefined;
  readonly startedAt: string;
  readonly processCaptureElicitation: ProcessCaptureElicitation;
}

export interface HydrateServerToolFamilyInput {
  readonly kind: ToolKind;
  readonly server: McpServer;
  readonly analysis: AnalysisOperationPort;
  readonly session: BinarySessionPort | undefined;
  readonly options: CreateServerOptions;
  readonly context: HydratedToolContext;
}

/**
 * Install production callbacks on generated lazy tool registrations.
 */
export const hydrateServerToolFamily = async ({
  kind,
  server,
  analysis,
  session,
  options,
  context,
}: HydrateServerToolFamilyInput): Promise<void> => {
  const toolContext = {
    server,
    analysis,
    session,
    options,
    logger: context.logger,
    permissionAuthority: context.permissionAuthority,
    activeTarget: context.activeTarget,
    recordEvidence: context.recordEvidence,
    recordEvidenceWithUnknown: context.recordEvidenceWithUnknown,
  };
  switch (kind) {
    case "official-proxy": {
      const { registerOfficialTools } = await import(
        "./registerOfficialTools.js"
      );
      registerOfficialTools(server, analysis, analysisOptions(toolContext));
      return;
    }
    case "enhanced": {
      const { registerEnhancedTools } = await import(
        "./registerEnhancedTools.js"
      );
      registerEnhancedTools(server, analysis, enhancedOptions(toolContext));
      return;
    }
    case "native-provider": {
      const { registerNativeTools } = await import("./registerNativeTools.js");
      registerNativeTools(server, analysis, evidenceOptions(toolContext));
      return;
    }
    case "artifact-provider": {
      const { registerArtifactTools } = await import(
        "./registerArtifactTools.js"
      );
      registerArtifactTools(server, analysis, {
        ...evidenceOptions(toolContext),
        ...(context.permissionAuthority === undefined
          ? {}
          : { permissionAuthority: context.permissionAuthority }),
      });
      return;
    }
    case "managed-provider": {
      const { registerManagedTools } = await import(
        "./registerManagedTools.js"
      );
      registerManagedTools(server, analysis, {
        ...evidenceOptions(toolContext),
        session,
      });
      return;
    }
    case "application":
      await registerApplicationFamily(toolContext);
      return;
    case "browser-provider":
    case "electron-provider":
    case "runtime-provider": {
      await hydrateObservationFamily(kind, toolContext);
      return;
    }
    case "session": {
      if (session === undefined)
        throw new TypeError("Session tools require a binary session");
      const { registerSessionTools } = await import(
        "./registerSessionTools.js"
      );
      registerSessionTools(server, session, context.logger, {
        ...options,
        ...(context.availabilityPolicy === undefined
          ? {}
          : { availabilityPolicy: context.availabilityPolicy }),
        ...(context.permissionAuthority === undefined
          ? {}
          : { permissionAuthority: context.permissionAuthority }),
        startedAt: context.startedAt,
        processCaptureElicitation: context.processCaptureElicitation,
      });
    }
  }
};

const hydrateObservationFamily = async (
  kind: "browser-provider" | "electron-provider" | "runtime-provider",
  context: ServerToolContext,
): Promise<void> => {
  const common = {
    logger: context.logger,
    permissionAuthority: context.permissionAuthority,
    recordEvidence: context.recordEvidence,
  };
  if (kind === "browser-provider") {
    const [{ registerBrowserTools }, { registerBrowserScenarioTool }] =
      await Promise.all([
        import("./registerBrowserTools.js"),
        import("./registerBrowserScenarioTool.js"),
      ]);
    registerBrowserTools(context.server, {
      ...common,
      browser: context.options.browserObservation,
    });
    registerBrowserScenarioTool(context.server, {
      ...common,
      provider: context.options.browserScenarioCapture,
    });
    return;
  }
  if (kind === "electron-provider") {
    const { registerElectronTools } = await import(
      "./registerElectronTools.js"
    );
    registerElectronTools(context.server, {
      ...common,
      electron: context.options.electronObservation,
      electronActive: context.options.electronActiveObservation,
    });
    return;
  }
  const { registerJavaScriptRuntimeObservationTools } = await import(
    "./registerJavaScriptRuntimeObservationTools.js"
  );
  registerJavaScriptRuntimeObservationTools(context.server, {
    ...common,
    runtime: context.options.javascriptRuntimeObservation,
  });
};

interface ServerToolContext {
  readonly server: McpServer;
  readonly analysis: AnalysisOperationPort;
  readonly session: BinarySessionPort | undefined;
  readonly options: CreateServerOptions;
  readonly logger: Logger;
  readonly permissionAuthority: PermissionAuthority | undefined;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordEvidenceWithUnknown:
    | BinarySessionPort["recordEvidenceWithUnknown"]
    | undefined;
}

const analysisOptions = ({
  logger,
  activeTarget,
  recordEvidence,
  session,
}: ServerToolContext) => {
  const recordUnknown =
    session === undefined
      ? undefined
      : (input: Parameters<typeof session.recordUnknown>[0]) =>
          session.recordUnknown(input);
  return {
    logger,
    activeTarget,
    recordEvidence,
    recordUnknown,
  };
};

const enhancedOptions = (context: ServerToolContext) => ({
  ...analysisOptions(context),
  analysisProfile:
    context.session === undefined
      ? undefined
      : () => context.session?.analysisProfile(),
});

const evidenceOptions = ({
  logger,
  activeTarget,
  recordEvidence,
}: ServerToolContext) => ({
  logger,
  activeTarget,
  recordEvidence,
});

const registerApplicationFamily = async ({
  server,
  session,
  options,
  logger,
  permissionAuthority,
  recordEvidence,
  recordEvidenceWithUnknown,
}: ServerToolContext): Promise<void> => {
  const [
    { registerApplicationTools },
    { registerManagedWorkflowTools },
    { LinuxJavaScriptReplayRunner },
    { SystemJavaScriptReplayHost },
  ] = await Promise.all([
    import("./registerApplicationTools.js"),
    import("./registerManagedWorkflowTools.js"),
    import("../replay/LinuxJavaScriptReplayRunner.js"),
    import("../replay/SystemJavaScriptReplayHost.js"),
  ]);
  if (session !== undefined)
    registerManagedWorkflowTools(server, {
      logger,
      recordEvidence,
      recordEvidenceWithUnknown,
      session,
      runtime: {
        policy: options.managedRuntimePolicy ?? {
          enabled: false,
          roots: [],
          executablePath: "/usr/bin/dotnet",
        },
        authority: permissionAuthority,
      },
    });
  registerApplicationTools(server, {
    logger,
    recordEvidence,
    recordEvidenceWithUnknown,
    evidenceLookup:
      session === undefined
        ? undefined
        : (evidenceId) => session.evidenceById(evidenceId),
    evidenceFilePolicy: options.evidenceFilePolicy ?? {
      roots: [],
      maxBytes: 1,
      maxDepth: 1,
      maxStringLength: 1,
      maxNodes: 1,
    },
    permissionAuthority,
    retainCoverageWorkspace:
      session === undefined
        ? undefined
        : (workspace) => {
            return session.retainReconstructionCoverageWorkspace(workspace);
          },
    replay: {
      policy: options.javascriptReplayPolicy ?? {
        enabled: false,
        roots: [],
        nodePath: process.execPath,
        bubblewrapPath: "/usr/bin/bwrap",
        systemdRunPath: "/usr/bin/systemd-run",
        systemctlPath: "/usr/bin/systemctl",
        shellPath: "/usr/bin/bash",
      },
      host: options.javascriptReplayHost ?? new SystemJavaScriptReplayHost(),
      runner:
        options.javascriptReplayRunner ?? new LinuxJavaScriptReplayRunner(),
      authority: permissionAuthority,
    },
  });
};
