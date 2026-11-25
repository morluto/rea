import type { ArtifactResourceScope } from "../../resources/index.js";
import { RawRasterDiscoveryService } from "../../application/binaryDiagnostics/RawRasterDiscoveryService.js";
export const createRawRasterDiscoveryService = (
  resources?: ArtifactResourceScope,
): RawRasterDiscoveryService =>
  new RawRasterDiscoveryService(undefined, resources);

import { StructuredRasterDiscoveryService } from "../../application/binaryDiagnostics/StructuredRasterDiscoveryService.js";
export const createStructuredRasterDiscoveryService = (
  resources?: ArtifactResourceScope,
): StructuredRasterDiscoveryService =>
  new StructuredRasterDiscoveryService(undefined, resources);

import { StructuredRasterExportService } from "../../application/binaryDiagnostics/StructuredRasterExportService.js";
export const createStructuredRasterExportService = (
  resources?: ArtifactResourceScope,
): StructuredRasterExportService =>
  new StructuredRasterExportService(undefined, resources);
