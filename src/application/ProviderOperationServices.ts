import type { RequestAnalysisPort } from "../ports/AnalysisProvider.js";
import type { JebAnalysisPort } from "../ports/jeb/JebAnalysisPort.js";
import type { UefiAnalysisPort } from "../ports/uefi/UefiAnalysisPort.js";
import {
  apktoolRequestSchema,
  type ApktoolOperation,
  type ApktoolRequest,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import {
  flutterRequestSchema,
  type FlutterOperation,
  type FlutterRequest,
} from "../domain/flutter/flutterBuildAnalysis.js";
import {
  jebRequestSchema,
  type JebOperation,
  type JebRequest,
} from "../domain/jeb/jebAnalysis.js";
import {
  pcapRequestSchema,
  type PcapOperation,
  type PcapRequest,
} from "../domain/pcap/pcapAnalysis.js";
import { createPcapEvidence } from "../domain/pcap/pcapEvidence.js";
import type { AnalysisPartialObservation } from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  createUefiEvidenceFromWrapper,
  isUefiObservationWrapper,
} from "../domain/uefi/uefiEvidence.js";
import {
  uefiRequestSchema,
  type UefiOperation,
  type UefiRequest,
} from "../domain/uefi/uefiFirmwareAnalysis.js";
import { ProviderOperationService } from "./ProviderOperationExecution.js";

export type ApktoolResourceAnalysisService = ProviderOperationService<
  ApktoolOperation,
  ApktoolRequest,
  RequestAnalysisPort<ApktoolRequest>
>;

export type FlutterBuildAnalysisService = ProviderOperationService<
  FlutterOperation,
  FlutterRequest,
  RequestAnalysisPort<FlutterRequest>
>;

export type JebAnalysisService = ProviderOperationService<
  JebOperation,
  JebRequest,
  JebAnalysisPort
>;

export type UefiAnalysisService = ProviderOperationService<
  UefiOperation,
  UefiRequest,
  UefiAnalysisPort
>;

export type PcapAnalysisService = ProviderOperationService<
  PcapOperation,
  PcapRequest,
  RequestAnalysisPort<PcapRequest>
>;

export const createApktoolResourceAnalysisService = (
  provider: RequestAnalysisPort<ApktoolRequest>,
): ApktoolResourceAnalysisService =>
  new ProviderOperationService(provider, apktoolRequestSchema, "observed");

export const createFlutterBuildAnalysisService = (
  provider: RequestAnalysisPort<FlutterRequest>,
): FlutterBuildAnalysisService =>
  new ProviderOperationService(provider, flutterRequestSchema, "observed");

export const createJebAnalysisService = (
  provider: JebAnalysisPort,
): JebAnalysisService =>
  new ProviderOperationService(provider, jebRequestSchema, (operation) =>
    operation === "decompile_jeb_item" ? "derived" : "observed",
  );

export const createUefiAnalysisService = (
  provider: UefiAnalysisPort,
): UefiAnalysisService => {
  const convertingProvider: UefiAnalysisPort = {
    inspectAvailability: (signal) => provider.inspectAvailability(signal),
    close: () => provider.close(),
    execute: async (request, options) => {
      const executed = await provider.execute(request, options);
      if (!executed.ok) {
        if (isUefiObservationWrapper(executed.error.partialObservation)) {
          executed.error.partialObservation = createUefiEvidenceFromWrapper(
            request.operation,
            request.input,
            executed.error.partialObservation,
          );
        }
        if (
          executed.error instanceof ProviderCleanupError &&
          isUefiObservationWrapper(executed.error.completedObservation)
        ) {
          const evidence = createUefiEvidenceFromWrapper(
            request.operation,
            request.input,
            executed.error.completedObservation,
          );
          (
            executed.error as {
              completedObservation?: AnalysisPartialObservation;
            }
          ).completedObservation = evidence;
          executed.error.partialObservation ??= evidence;
        }
      }
      return executed;
    },
  };
  return new ProviderOperationService(
    convertingProvider,
    uefiRequestSchema,
    (operation) =>
      operation === "decompile_uefi_firmware" ? "derived" : "observed",
  );
};

export const createPcapAnalysisService = (
  provider: RequestAnalysisPort<PcapRequest>,
): PcapAnalysisService =>
  new ProviderOperationService(
    provider,
    pcapRequestSchema,
    "observed",
    createPcapEvidence,
  );
