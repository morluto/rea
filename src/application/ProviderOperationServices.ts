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
): UefiAnalysisService =>
  new ProviderOperationService(provider, uefiRequestSchema, "observed");

export const createPcapAnalysisService = (
  provider: RequestAnalysisPort<PcapRequest>,
): PcapAnalysisService =>
  new ProviderOperationService(
    provider,
    pcapRequestSchema,
    "observed",
    createPcapEvidence,
  );
