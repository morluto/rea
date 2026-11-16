import type { CapabilityAvailabilityProbes } from "../application/CapabilityAvailability.js";
import { registerNativeFunctionMatchingTool } from "./registerNativeFunctionMatchingTool.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { ProcessCaptureResourceScope } from "../process/capture/ProcessCaptureLifecycle.js";
import { ProcessCaptureError } from "../process/capture/ProcessCaptureError.js";
import { toolContract } from "../contracts/toolContracts.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "pino";
import type { ProviderAvailability } from "../ports/AnalysisProvider.js";
import { registerCloseLifecycleTool } from "./registerCloseLifecycleTool.js";
import { registerResetInvestigationTool } from "./registerResetInvestigationTool.js";
import { registerServiceTools } from "./serviceToolBindings.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { errorMessage } from "../kernel/errorMessage.js";

export interface LifecycleToolRegistration extends CapabilityAvailabilityProbes {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort;
  readonly logger: Logger;
  readonly closeContract: ReturnType<typeof toolContract<"close_binary">>;
  readonly startedAt: string;
  readonly availabilityPolicy: () => AvailabilityPolicy;
  readonly artifactResources: ArtifactResourceScope;
  readonly closeProcessResources: () => Promise<Result<null, AnalysisError>>;
}

const registerLifecycleTools = (
  registration: LifecycleToolRegistration,
): void => {
  registerCloseLifecycleTool(registration);
  registerResetInvestigationTool(registration);
  registerServiceTools(
    registration.server,
    { sessionStatus: registration },
    { logger: registration.logger },
  );
};

/** Register MCP-only target lifecycle operations on a long-lived session. */
export interface SessionToolOptions extends Partial<CapabilityAvailabilityProbes> {
  readonly artifactResources: ArtifactResourceScope;
  /** Server environment snapshot that process capture resolves and inherits. */
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  /** The host process capture plans for and runs on. */
  readonly platform: NodeJS.Platform;
  readonly startedAt?: string;
  readonly availabilityPolicy?: () => AvailabilityPolicy;
}

export const registerSessionTools = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  logger: Logger,
  options: SessionToolOptions,
): void => {
  const closeContract = toolContract("close_binary");
  const processResources = new ProcessCaptureResourceScope();
  registerLifecycleTools({
    ...options,
    server,
    session,
    logger,
    closeContract,
    startedAt: options.startedAt ?? new Date().toISOString(),
    availabilityPolicy: sessionAvailabilityPolicy(
      options.availabilityPolicy,
      {},
      options.platform,
    ),
    androidAnalysisAvailability:
      options.androidAnalysisAvailability ?? missingAndroidAvailability,
    closeProcessResources: async () => {
      try {
        await processResources.retryCleanup();
        return ok(null);
      } catch (cause: unknown) {
        if (cause instanceof AnalysisError) return err(cause);
        return err(
          new ProcessCaptureError(
            "process capture cleanup remains incomplete",
            {
              cause,
              reason: "cleanup_incomplete",
              cleanup: {
                reason: "process capture cleanup remains incomplete",
                resources: ["process_capture_resources"],
              },
              executionFailure:
                cause instanceof Error
                  ? cause.message || cause.name
                  : String(cause),
            },
          ),
        );
      }
    },
  });
  const closeServer = server.close.bind(server);
  server.close = async () => {
    const results = await Promise.allSettled([
      closeServer(),
      processResources.close(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "REA session cleanup failed");
  };
  const previousOnclose = server.server.onclose;
  server.server.onclose = () => {
    try {
      previousOnclose?.();
    } finally {
      void processResources.close().catch((cause: unknown) => {
        logger.error(
          { error: errorMessage(cause) },
          "Process capture cleanup failed during server shutdown",
        );
      });
    }
  };
  registerServiceTools(
    server,
    {
      binaryTarget: session,
      analysisContext: {},
      processCapture: {
        session,
        environment: options.environment,
        platform: options.platform,
        resources: processResources,
      },
      sessionDerived: { session, resources: options.artifactResources },
      sessionRecords: { session, resources: options.artifactResources },
    },
    {
      logger,
      withAdmittedAnalysis: withAdmittedAnalysis({ kind: "session", session }),
    },
  );
  registerNativeFunctionMatchingTool(
    server,
    session,
    logger,
    options.environment,
  );
};

const missingAndroidAvailability = async (): Promise<ProviderAvailability> => ({
  status: "unavailable",
  code: "not_configured",
  reason: "No Android JADX analysis provider is configured.",
  remediation:
    "Set REA_JADX_MCP_JAR to the jadx-headless-mcp 0.7.1 release JAR (rea doctor --provider jadx names its download URL and SHA-256) and provide a full JDK on Linux, macOS, or Windows x64 with its matching bundled native controls.",
  diagnostics: { configured: false },
});
