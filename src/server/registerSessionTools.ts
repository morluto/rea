import type { CapabilityAvailabilityProbes } from "../application/CapabilityAvailability.js";
import { runtimeNativeMatchingAllowance } from "../config/runtimeAnalysisSettings.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { ProcessCaptureResourceScope } from "../process/capture/ProcessCaptureLifecycle.js";
import { ProcessCaptureError } from "../process/capture/ProcessCaptureError.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "pino";
import type { ProviderAvailability } from "../ports/AnalysisProvider.js";
import { registerServiceTools } from "./serviceToolBindings.js";
import type { SessionLifecycleOptions } from "./sessionLifecycle.js";
import type { SessionStatusToolOptions } from "./sessionStatusTool.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** What the lifecycle and status tools of one session need. */
interface LifecycleToolRegistration
  extends SessionStatusToolOptions, SessionLifecycleOptions {}

/** Close, reset and status run outside analysis admission; the session orders them. */
const registerLifecycleTools = (
  registration: LifecycleToolRegistration,
): void => {
  registerServiceTools(
    registration.server,
    { sessionLifecycle: registration, sessionStatus: registration },
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
  const processResources = new ProcessCaptureResourceScope();
  registerLifecycleTools({
    ...options,
    server,
    session,
    logger,
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
  server.registerCloseHook(() => processResources.close(), {
    failureMessage: "REA session cleanup failed",
    alwaysAggregate: true,
  });
  server.registerTransportCloseHook(() => {
    void processResources.close().catch((cause: unknown) => {
      logger.error(
        { error: errorMessage(cause) },
        "Process capture cleanup failed during server shutdown",
      );
    });
  });
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
  // Native matching records in the session itself and reads each accepted
  // call's settings snapshot over the launch value.
  registerServiceTools(
    server,
    {
      nativeFunctionMatching: {
        session,
        allowance: runtimeNativeMatchingAllowance(
          options.environment,
          server.analysisSettings?.read,
        ),
      },
    },
    {
      logger,
      recordEvidence: (evidence) => session.recordEvidence(evidence),
      withAdmittedAnalysis: withAdmittedAnalysis({ kind: "session", session }),
    },
  );
};

const missingAndroidAvailability = async (): Promise<ProviderAvailability> => ({
  status: "unavailable",
  code: "not_configured",
  reason: "No Android JADX analysis provider is configured.",
  // The Android boundary owns the versioned remediation; this composition
  // default names no release so it cannot drift from the pinned engine.
  remediation:
    "Set REA_JADX_MCP_JAR to a caller-supplied jadx-headless-mcp JAR (rea doctor --provider jadx names its download URL and SHA-256) and provide a full JDK on Linux, macOS, or Windows x64 with its matching bundled native controls.",
  diagnostics: { configured: false },
});
