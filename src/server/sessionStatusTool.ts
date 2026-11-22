import type { ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { CapabilityAvailabilityProbes } from "../application/CapabilityAvailability.js";
import {
  BINARY_SESSION_SUMMARY_OMITTED_FIELDS,
  type BinarySessionDetail,
} from "../contracts/sessionStatusContract.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { ProviderAvailability } from "../ports/AnalysisProvider.js";
import type { JebAnalysisAvailability } from "../ports/jeb/JebAnalysisPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  buildCapabilityInventory,
  compactToolAvailability,
} from "../application/CapabilityInventory.js";
import { restrictAdvertisedCapabilities } from "../application/binary/BinarySessionStatus.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolFamilyId } from "../contracts/toolFamilyIds.js";
import type {
  ClientFeatureAvailability,
  ToolAvailability,
} from "../contracts/toolOutputSchemaPrimitives.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { createServerIdentity } from "../process/ServerIdentity.js";
import { mcpClientMetadata } from "./mcpClientMetadata.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { err, ok, type Result } from "../domain/result.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";

/** The parsed `binary_session` request. */
export type BinarySessionStatusInput = z.output<
  ReturnType<typeof toolContract<"binary_session">>["inputSchema"]
>;

/** Inputs required to report binary session status. */
export interface SessionStatusToolOptions extends CapabilityAvailabilityProbes {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort;
  readonly startedAt: string;
  readonly availabilityPolicy: () => AvailabilityPolicy;
}

/**
 * Probe only families this registration advertises. Scoped-out providers keep
 * the established not-configured shape instead of launching probes whose tools
 * cannot appear in the response.
 */
const probeSessionAvailability = async (
  probes: CapabilityAvailabilityProbes,
  signal: AbortSignal,
  advertisesFamily: (family: ToolFamilyId) => boolean,
): Promise<{
  readonly android: ProviderAvailability | undefined;
  readonly adb: ProviderAvailability | undefined;
  readonly apktool: ProviderAvailability | undefined;
  readonly jeb: JebAnalysisAvailability | undefined;
  readonly evmLimiter: ProviderAvailability | undefined;
}> => {
  const probe = <T>(family: ToolFamilyId, run: () => Promise<T> | undefined) =>
    advertisesFamily(family) ? Promise.resolve().then(run) : undefined;
  const pending = [
    probe("android", () => probes.androidAnalysisAvailability(signal)),
    probe("adb", () => probes.adbAnalysisAvailability?.(signal)),
    probe("apktool", () => probes.apktoolAnalysisAvailability?.(signal)),
    probe("jeb", () => probes.jebAnalysisAvailability?.(signal)),
    probe("artifact", () => probes.evmLimiterAvailability?.(signal)),
  ] as const;
  try {
    const [android, adb, apktool, jeb, evmLimiter] = await Promise.all(pending);
    return { android, adb, apktool, jeb, evmLimiter };
  } catch (cause: unknown) {
    const settled = await Promise.allSettled(pending);
    let failure = cause;
    for (const result of settled) {
      if (
        result.status !== "rejected" ||
        result.reason === cause ||
        !(result.reason instanceof AnalysisError) ||
        !result.reason.cleanupIncomplete
      )
        continue;
      const primary =
        failure instanceof AnalysisError
          ? failure
          : new ProviderAdapterError("rea", "binary_session", {
              cause: failure,
            });
      failure = analysisErrorWithCleanupDependencies(
        primary,
        result.reason,
        "binary_session",
      );
    }
    throw failure;
  }
};

/** Report provider, target and tool availability for one status request. */
export const readSessionStatus = async (
  options: SessionStatusToolOptions,
  input: BinarySessionStatusInput,
  context: ServerContext,
): Promise<Result<JsonValue, AnalysisError>> => {
  const { server, session, startedAt, availabilityPolicy } = options;
  const { client, clientFeatures, protocolVersion } = mcpClientMetadata(
    context,
    server.server,
  );
  let availabilityResults: Awaited<ReturnType<typeof probeSessionAvailability>>;
  let status: JsonValue;
  try {
    availabilityResults = await probeSessionAvailability(
      options,
      context.mcpReq.signal,
      (family) => server.advertisesFamily(family),
    );
    // Snapshot the session only after readiness inspection finishes so
    // session changes occurring before probe completion are reflected.
    status = await session.status({
      signal: context.mcpReq.signal,
      detail: input.detail,
      refreshCandidates: input.refresh_candidates,
    });
  } catch (cause) {
    if (!(cause instanceof AnalysisError)) throw cause;
    return err(cause);
  }
  const statusObject = jsonObjectSchema.parse(status);
  // Availability is derived from the complete provider facts: an
  // advertised composed tool still depends on direct operations the
  // registration hides. Advertisement narrows only the public report.
  const toolAvailability = buildCapabilityInventory(
    status,
    {
      ...availabilityPolicy(),
      ...(availabilityResults.android === undefined
        ? {}
        : { androidAnalysisAvailability: availabilityResults.android }),
      ...(availabilityResults.adb === undefined
        ? {}
        : { adbAnalysisAvailability: availabilityResults.adb }),
      ...(availabilityResults.apktool === undefined
        ? {}
        : { apktoolAnalysisAvailability: availabilityResults.apktool }),
      ...(availabilityResults.jeb === undefined
        ? {}
        : { jebAnalysisAvailability: availabilityResults.jeb }),
      ...(availabilityResults.evmLimiter === undefined
        ? {}
        : { evmLimiterAvailability: availabilityResults.evmLimiter }),
    },
    (name) => server.advertisesTool(name),
  );
  const serverIdentity = createServerIdentity({
    startedAt,
    commandPath: CURRENT_ENTRYPOINT_PATH,
    catalog: server.catalogIdentity,
    expected: {
      ...(input.expected_package_version === undefined
        ? {}
        : { package_version: input.expected_package_version }),
      ...(input.expected_catalog_digest === undefined
        ? {}
        : { catalog_digest: input.expected_catalog_digest }),
      ...(input.expected_server_path === undefined
        ? {}
        : { server_path: input.expected_server_path }),
    },
    ...(client === undefined ? {} : { client }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
  });
  return ok(
    projectSessionStatus({
      detail: input.detail,
      status:
        server.advertisedToolFamilies === undefined
          ? statusObject
          : restrictAdvertisedCapabilities(statusObject, (operation) =>
              server.advertisesTool(operation),
            ),
      toolAvailability,
      serverIdentity,
      clientFeatures,
    }),
  );
};

const projectSessionStatus = (options: {
  readonly detail: BinarySessionDetail;
  readonly status: Readonly<
    Record<string, import("../domain/jsonValue.js").JsonValue>
  >;
  readonly toolAvailability: readonly ToolAvailability[];
  readonly serverIdentity: ReturnType<typeof createServerIdentity>;
  readonly clientFeatures: ClientFeatureAvailability;
}) =>
  jsonObjectSchema.parse({
    ...options.status,
    detail: options.detail,
    ...(options.detail === "summary"
      ? { omitted_fields: [...BINARY_SESSION_SUMMARY_OMITTED_FIELDS] }
      : {}),
    tool_availability: compactToolAvailability(
      options.toolAvailability,
      options.detail,
    ),
    client_features: options.clientFeatures,
    server_identity: options.serverIdentity,
  });
