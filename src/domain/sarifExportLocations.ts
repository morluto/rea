import type { z } from "zod";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { digestSchema } from "./digests.js";
import type { evidenceLocationSchema } from "./evidence.js";
import {
  normalizeSarifArtifactUri,
  type SarifExportErrorCode,
  SarifExportError,
} from "./sarifExportCategories.js";
import type {
  SarifAddress,
  SarifArtifact,
  SarifArtifactLocation,
  SarifExportArtifactInput,
  SarifExportFindingLocationInput,
  SarifLocation,
  SarifLocationAvailability,
  SarifLogicalLocation,
  SarifMissingLocationField,
  SarifPhysicalLocation,
  SarifRegion,
} from "./sarifExportSchemas.js";

type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;

export const trimOptionalString = (
  value: string | null | undefined,
): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

/**
 * Convert a structured REA `Evidence["locations"][number]` observation location
 * into a `SarifExportFindingLocationInput` without fabricating unavailable fields.
 */
export const convertEvidenceLocationToSarifLocationInput = (
  evidenceLocation: EvidenceLocation,
  defaultArtifactUri?: string | null,
): SarifExportFindingLocationInput => {
  const baseUriPart = defaultArtifactUri ? { uri: defaultArtifactUri } : {};
  switch (evidenceLocation.kind) {
    case "artifact-path":
      return { uri: evidenceLocation.path };
    case "address":
      return { ...baseUriPart, address: evidenceLocation.address };
    case "address-range":
      return {
        ...baseUriPart,
        address: `${evidenceLocation.start}..${evidenceLocation.end}`,
      };
    case "file-offset":
      return { ...baseUriPart, byteOffset: evidenceLocation.offset };
    case "file-offset-range": {
      const length = evidenceLocation.end - evidenceLocation.start;
      if (length < 0) {
        throw new SarifExportError(
          "invalid_location_metadata",
          `Invalid file-offset-range coordinates (${String(evidenceLocation.start)}..${String(evidenceLocation.end)})`,
        );
      }
      return {
        ...baseUriPart,
        byteOffset: evidenceLocation.start,
        ...(length > 0 ? { byteLength: length } : {}),
      };
    }
  }
};

const parseNonNegativeSafeIntegerAddress = (
  addressText: string,
): number | undefined => {
  const trimmed = addressText.trim();
  const isHex = /^0x[0-9a-fA-F]+$/u.test(trimmed);
  const isDec = /^[0-9]+$/u.test(trimmed);
  if (!isHex && !isDec) return undefined;
  const parsed = isHex
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const validateIntegerBound = (
  value: number | null | undefined,
  fieldName: string,
  minValue: number,
  findingId: string,
): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minValue) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} has invalid ${fieldName} (${String(value)}); ${fieldName} must be an integer >= ${String(minValue)} when provided.`,
      { findingId },
    );
  }
  return value;
};

interface ValidatedLocationCoords {
  readonly startLine: number | undefined;
  readonly startColumn: number | undefined;
  readonly endLine: number | undefined;
  readonly endColumn: number | undefined;
  readonly byteOffset: number | undefined;
  readonly byteLength: number | undefined;
  readonly addressLengthBytes: number | undefined;
}

const throwLocationError = (findingId: string, message: string): never => {
  throw new SarifExportError("invalid_location_metadata", message, {
    findingId,
  });
};

const checkLineAndColumnInvariants = (
  c: ValidatedLocationCoords,
  findingId: string,
): void => {
  if (
    c.startLine === undefined &&
    (c.startColumn !== undefined ||
      c.endLine !== undefined ||
      c.endColumn !== undefined)
  ) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} specifies column or endLine without startLine.`,
    );
  }
  if (
    c.startLine !== undefined &&
    c.endLine !== undefined &&
    c.endLine < c.startLine
  ) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} specifies endLine (${String(c.endLine)}) < startLine (${String(c.startLine)}).`,
    );
  }
  const sameLine = c.endLine === undefined || c.endLine === c.startLine;
  if (sameLine && c.endColumn !== undefined) {
    if (c.startColumn === undefined) {
      throwLocationError(
        findingId,
        `Finding ${JSON.stringify(findingId)} specifies endColumn on a single-line region without startColumn.`,
      );
    }
    if (c.endColumn < (c.startColumn ?? 0)) {
      throwLocationError(
        findingId,
        `Finding ${JSON.stringify(findingId)} specifies endColumn < startColumn on the same line.`,
      );
    }
  }
  if (c.byteLength !== undefined && c.byteOffset === undefined) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} specifies byteLength without byteOffset.`,
    );
  }
};

const validateLocationCoordinates = (
  loc: SarifExportFindingLocationInput,
  id: string,
): ValidatedLocationCoords => {
  const coords: ValidatedLocationCoords = {
    startLine: validateIntegerBound(loc.startLine, "startLine", 1, id),
    startColumn: validateIntegerBound(loc.startColumn, "startColumn", 1, id),
    endLine: validateIntegerBound(loc.endLine, "endLine", 1, id),
    endColumn: validateIntegerBound(loc.endColumn, "endColumn", 1, id),
    byteOffset: validateIntegerBound(loc.byteOffset, "byteOffset", 0, id),
    byteLength: validateIntegerBound(loc.byteLength, "byteLength", 1, id),
    addressLengthBytes: validateIntegerBound(
      loc.addressLengthBytes,
      "addressLengthBytes",
      1,
      id,
    ),
  };
  checkLineAndColumnInvariants(coords, id);
  return coords;
};

const buildRegionFromCoords = (
  c: ValidatedLocationCoords,
  snippetText: string | null | undefined,
  findingId: string,
): SarifRegion | undefined => {
  const snippet = trimOptionalString(snippetText);
  if (c.startLine === undefined && c.byteOffset === undefined) {
    if (snippet !== undefined) {
      throwLocationError(
        findingId,
        `Finding ${JSON.stringify(findingId)} specifies snippetText without startLine or byteOffset.`,
      );
    }
    return undefined;
  }
  return {
    ...(c.startLine === undefined ? {} : { startLine: c.startLine }),
    ...(c.startColumn === undefined ? {} : { startColumn: c.startColumn }),
    ...(c.endLine === undefined ? {} : { endLine: c.endLine }),
    ...(c.endColumn === undefined ? {} : { endColumn: c.endColumn }),
    ...(c.byteOffset === undefined ? {} : { byteOffset: c.byteOffset }),
    ...(c.byteLength === undefined ? {} : { byteLength: c.byteLength }),
    ...(snippet === undefined ? {} : { snippet: { text: snippet } }),
  };
};

const buildAddressObject = (
  rawAddress: string | null | undefined,
  addressLengthBytes: number | undefined,
  findingId: string,
): SarifAddress | undefined => {
  if (rawAddress === undefined || rawAddress === null) {
    if (addressLengthBytes !== undefined) {
      throwLocationError(
        findingId,
        `Finding ${JSON.stringify(findingId)} specifies addressLengthBytes without address.`,
      );
    }
    return undefined;
  }
  const trimmed = rawAddress.trim();
  if (trimmed.length === 0) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} has an empty address string.`,
    );
  }
  const numericAddress = parseNonNegativeSafeIntegerAddress(trimmed);
  return {
    fullyQualifiedName: trimmed,
    ...(numericAddress === undefined
      ? {}
      : { absoluteAddress: numericAddress }),
    ...(addressLengthBytes === undefined ? {} : { length: addressLengthBytes }),
  };
};

const buildLogicalLocationsList = (
  rawLogicalName: string | null | undefined,
  rawLogicalKind: string | null | undefined,
  addressObj: SarifAddress | undefined,
  findingId: string,
): SarifLogicalLocation[] | undefined => {
  const kind = trimOptionalString(rawLogicalKind);
  if (rawLogicalName !== undefined && rawLogicalName !== null) {
    const trimmedName = rawLogicalName.trim();
    if (trimmedName.length === 0) {
      throwLocationError(
        findingId,
        `Finding ${JSON.stringify(findingId)} has an empty logicalName string.`,
      );
    }
    return [
      {
        name: trimmedName,
        fullyQualifiedName: trimmedName,
        ...(kind === undefined ? {} : { kind }),
      },
    ];
  }
  if (addressObj !== undefined) {
    return [
      {
        name: addressObj.fullyQualifiedName,
        fullyQualifiedName: addressObj.fullyQualifiedName,
        kind: kind ?? "address",
      },
    ];
  }
  if (kind !== undefined) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} specifies logicalKind without logicalName or address.`,
    );
  }
  return undefined;
};

const resolveLocationUri = (
  rawUri: string | null | undefined,
  findingId: string,
): string | undefined => {
  if (rawUri === undefined || rawUri === null) return undefined;
  const uriResult = normalizeSarifArtifactUri(rawUri);
  if (!uriResult.ok) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Finding ${JSON.stringify(findingId)} has invalid artifact URI ${JSON.stringify(rawUri)}: ${uriResult.error}`,
      { findingId },
    );
  }
  return uriResult.value;
};

const normalizeSingleFindingLocation = (
  loc: SarifExportFindingLocationInput,
  fallbackArtifactUri: string | null | undefined,
  findingId: string,
) => {
  const normalizedUri = resolveLocationUri(
    loc.uri ?? fallbackArtifactUri,
    findingId,
  );
  const coords = validateLocationCoordinates(loc, findingId);
  const region = buildRegionFromCoords(coords, loc.snippetText, findingId);
  const addressObj = buildAddressObject(
    loc.address,
    coords.addressLengthBytes,
    findingId,
  );
  const logicalLocations = buildLogicalLocationsList(
    loc.logicalName,
    loc.logicalKind,
    addressObj,
    findingId,
  );
  const uriBaseId = trimOptionalString(loc.uriBaseId);
  if (uriBaseId !== undefined && normalizedUri === undefined) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} specifies uriBaseId without uri.`,
    );
  }
  const artifactLocation: SarifArtifactLocation | undefined =
    normalizedUri === undefined
      ? undefined
      : {
          uri: normalizedUri,
          ...(uriBaseId === undefined ? {} : { uriBaseId }),
        };

  const physicalLocation: SarifPhysicalLocation | undefined =
    artifactLocation !== undefined ||
    region !== undefined ||
    addressObj !== undefined
      ? {
          ...(artifactLocation === undefined ? {} : { artifactLocation }),
          ...(region === undefined ? {} : { region }),
          ...(addressObj === undefined ? {} : { address: addressObj }),
        }
      : undefined;

  if (physicalLocation === undefined && logicalLocations === undefined) {
    throwLocationError(
      findingId,
      `Finding ${JSON.stringify(findingId)} includes an empty location entry with no uri, region, address, or logicalName.`,
    );
  }

  return {
    location: {
      ...(physicalLocation === undefined ? {} : { physicalLocation }),
      ...(logicalLocations === undefined ? {} : { logicalLocations }),
    } satisfies SarifLocation,
    normalizedUri,
    hasRegion: region !== undefined,
    hasStartLine: coords.startLine !== undefined,
  };
};

export const buildNormalizedFindingLocations = (
  rawLocations: readonly SarifExportFindingLocationInput[] | null | undefined,
  fallbackArtifactUri: string | null | undefined,
  findingId: string,
): {
  readonly locations: SarifLocation[];
  readonly availability: SarifLocationAvailability;
  readonly missingFields: SarifMissingLocationField[];
  readonly discoveredUris: Set<string>;
} => {
  const discoveredUris = new Set<string>();
  const fallbackTrimmed = trimOptionalString(fallbackArtifactUri);
  const effectiveInputs: SarifExportFindingLocationInput[] =
    rawLocations === undefined
      ? fallbackTrimmed
        ? [{ uri: fallbackTrimmed }]
        : []
      : rawLocations === null
        ? []
        : [...rawLocations];

  if (effectiveInputs.length === 0) {
    return {
      locations: [],
      availability: "unavailable",
      missingFields: ["uri", "region", "logicalLocation"],
      discoveredUris,
    };
  }

  const builtLocationsByKey = new Map<string, SarifLocation>();
  const missingSet = new Set<SarifMissingLocationField>();
  let allComplete = true;

  for (const loc of effectiveInputs) {
    const single = normalizeSingleFindingLocation(
      loc,
      fallbackArtifactUri,
      findingId,
    );
    if (single.normalizedUri === undefined) {
      allComplete = false;
      missingSet.add("uri");
    } else {
      discoveredUris.add(single.normalizedUri);
    }
    if (!single.hasRegion) {
      allComplete = false;
      missingSet.add("region");
      missingSet.add("startLine");
    } else if (!single.hasStartLine) {
      allComplete = false;
      missingSet.add("startLine");
    }
    builtLocationsByKey.set(JSON.stringify(single.location), single.location);
  }

  const sortedLocations = [...builtLocationsByKey.entries()]
    .sort(([keyA], [keyB]) => compareUnicodeCodePoints(keyA, keyB))
    .map(([, location]) => location);

  const orderedMissingFields = (
    ["uri", "region", "startLine", "logicalLocation"] as const
  ).filter((field) => missingSet.has(field));

  return {
    locations: sortedLocations,
    availability: allComplete ? "complete" : "partial",
    missingFields: allComplete ? [] : orderedMissingFields,
    discoveredUris,
  };
};

export const validateOptionalDigest = (
  rawDigest: string | null | undefined,
  errorCode: SarifExportErrorCode,
  label: string,
  findingId?: string,
): string | undefined => {
  if (rawDigest === undefined || rawDigest === null) return undefined;
  const parsed = digestSchema.safeParse(rawDigest);
  if (!parsed.success) {
    throw new SarifExportError(
      errorCode,
      `Invalid ${label} SHA-256 digest: ${JSON.stringify(rawDigest)}`,
      findingId === undefined ? undefined : { findingId },
    );
  }
  return parsed.data;
};

const assertCompatibleField = <T>(
  existing: T | undefined,
  incoming: T | undefined,
  field: string,
  uri: string,
): T | undefined => {
  if (
    existing !== undefined &&
    incoming !== undefined &&
    existing !== incoming
  ) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Conflicting ${field} declared for artifact URI ${JSON.stringify(uri)}`,
    );
  }
  return incoming ?? existing;
};

const mergeArtifactProperties = (
  existing: SarifArtifact | undefined,
  rawArtifact: SarifExportArtifactInput,
  uri: string,
): SarifArtifact["properties"] => {
  if (
    existing?.properties === undefined &&
    rawArtifact.format === undefined &&
    rawArtifact.architecture === undefined
  ) {
    return undefined;
  }
  const nextFormat = assertCompatibleField(
    existing?.properties?.rea_format ?? undefined,
    trimOptionalString(rawArtifact.format),
    "format",
    uri,
  );
  const nextArch = assertCompatibleField(
    existing?.properties?.rea_architecture ?? undefined,
    trimOptionalString(rawArtifact.architecture),
    "architecture",
    uri,
  );
  return {
    rea_format: nextFormat ?? null,
    rea_architecture: nextArch ?? null,
  };
};

export const registerInputArtifact = (
  artifactsByUri: Map<string, SarifArtifact>,
  rawArtifact: SarifExportArtifactInput,
): void => {
  const uriResult = normalizeSarifArtifactUri(rawArtifact.uri);
  if (!uriResult.ok) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Invalid artifact URI ${JSON.stringify(rawArtifact.uri)}: ${uriResult.error}`,
    );
  }
  const uri = uriResult.value;
  if (
    rawArtifact.bytes !== undefined &&
    rawArtifact.bytes !== null &&
    (!Number.isSafeInteger(rawArtifact.bytes) || rawArtifact.bytes < 0)
  ) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Artifact ${JSON.stringify(uri)} has invalid byte length (${String(rawArtifact.bytes)}).`,
    );
  }
  const existing = artifactsByUri.get(uri);
  const sha = assertCompatibleField(
    existing?.hashes?.["sha-256"],
    validateOptionalDigest(
      rawArtifact.sha256,
      "invalid_artifact_uri",
      `artifact ${JSON.stringify(uri)}`,
    ),
    "SHA-256 digest",
    uri,
  );
  const lengthVal = assertCompatibleField(
    existing?.length,
    typeof rawArtifact.bytes === "number" ? rawArtifact.bytes : undefined,
    "byte length",
    uri,
  );
  const sourceLang = assertCompatibleField(
    existing?.sourceLanguage,
    trimOptionalString(rawArtifact.sourceLanguage),
    "sourceLanguage",
    uri,
  );
  const properties = mergeArtifactProperties(existing, rawArtifact, uri);

  artifactsByUri.set(uri, {
    location: { uri },
    ...(lengthVal === undefined ? {} : { length: lengthVal }),
    ...(sourceLang === undefined ? {} : { sourceLanguage: sourceLang }),
    ...(sha === undefined ? {} : { hashes: { "sha-256": sha } }),
    ...(properties === undefined ? {} : { properties }),
  });
};
