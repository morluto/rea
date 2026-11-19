import {
  recordValue,
  cdpStringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

export type FrameSelection = "main" | "other" | "unknown";
export type FrameParentRelation =
  | "root"
  | "child"
  | "unknown"
  | "not_applicable";

/** Normalized frame identity facts shared by all selected-frame consumers. */
export interface CdpFrameIdentity {
  readonly applicability: "applicable" | "not_applicable";
  readonly selection: FrameSelection;
  readonly isRootReplacement: boolean;
  readonly frameId: string | null;
  readonly identityIssue:
    | "missing_params"
    | "invalid_params"
    | "missing_frame"
    | "missing_id"
    | "invalid_id"
    | null;
  readonly parentRelation: FrameParentRelation;
  readonly parentId: string | null;
  readonly parentIssue:
    | "invalid_parent_id"
    | "self_parent"
    | "main_frame_has_parent"
    | null;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const identityIssueFor = (
  navigated: boolean,
  frame: UnknownRecord | undefined,
  rawId: unknown,
): CdpFrameIdentity["identityIssue"] => {
  if (navigated && frame === undefined) return "missing_frame";
  if (rawId === undefined) return "missing_id";
  return nonEmptyString(rawId) === undefined ? "invalid_id" : null;
};

const noParent = {
  parentRelation: "not_applicable",
  parentId: null,
  parentIssue: null,
} as const;

const requiredChildParentFacts = (
  frameId: string | null,
  rawParent: unknown,
): Pick<CdpFrameIdentity, "parentRelation" | "parentId" | "parentIssue"> => {
  const parentId = nonEmptyString(rawParent);
  return parentId === undefined || parentId === frameId
    ? {
        parentRelation: "unknown",
        parentId: null,
        parentIssue:
          parentId === undefined ? "invalid_parent_id" : "self_parent",
      }
    : { parentRelation: "child", parentId, parentIssue: null };
};

const frameParentFacts = (
  frame: UnknownRecord | undefined,
): Pick<CdpFrameIdentity, "parentRelation" | "parentId" | "parentIssue"> => {
  if (frame === undefined)
    return { parentRelation: "unknown", parentId: null, parentIssue: null };
  if (!("parentId" in frame))
    return { parentRelation: "root", parentId: null, parentIssue: null };
  return requiredChildParentFacts(
    nonEmptyString(frame.id) ?? null,
    frame.parentId,
  );
};

/** Select navigation authority from already parsed source facts. */
export const selectCdpFrameIdentity = (
  facts: CdpFrameFacts,
  mainFrameId: string,
): CdpFrameIdentity => {
  if (
    facts.kind !== "navigated" &&
    facts.kind !== "requested" &&
    facts.kind !== "within_document"
  )
    return {
      applicability: "not_applicable",
      selection: "unknown",
      isRootReplacement: false,
      frameId: null,
      identityIssue: null,
      parentRelation: "not_applicable",
      parentId: null,
      parentIssue: null,
    };
  const { frameId, identityIssue, parentRelation, parentId, parentIssue } =
    facts;
  const identity = {
    frameId,
    identityIssue,
    parentRelation,
    parentId,
    parentIssue,
  };
  const selection =
    identity.frameId === null
      ? "unknown"
      : identity.frameId === mainFrameId
        ? "main"
        : "other";
  return {
    applicability: "applicable",
    selection,
    isRootReplacement:
      selection === "other" && identity.parentRelation === "root",
    ...identity,
    parentIssue:
      selection === "main" &&
      (identity.parentRelation === "child" ||
        identity.parentIssue === "self_parent")
        ? "main_frame_has_parent"
        : identity.parentIssue,
  };
};

/** Source observations independent of selected-frame authority or URL policy. */
export interface CdpFrameFacts extends Pick<
  CdpFrameIdentity,
  "frameId" | "identityIssue" | "parentRelation" | "parentId" | "parentIssue"
> {
  readonly kind:
    | "record"
    | "navigated"
    | "attached"
    | "detached"
    | "within_document"
    | "requested"
    | "not_applicable";
  readonly loaderId: string | undefined;
  readonly loaderIssue: "invalid_loader_id" | null;
}

const loaderFacts = (source: UnknownRecord | undefined) => ({
  loaderId: cdpStringValue(source?.loaderId),
  loaderIssue:
    source?.loaderId !== undefined && typeof source.loaderId !== "string"
      ? ("invalid_loader_id" as const)
      : null,
});

/** Parse a frame-tree or committed-document record using its declared keys. */
export const cdpFrameRecordFacts = (
  source: UnknownRecord | undefined,
): CdpFrameFacts => {
  const frameId = nonEmptyString(source?.id) ?? null;
  return {
    kind: "record",
    frameId,
    identityIssue: identityIssueFor(true, source, source?.id),
    ...frameParentFacts(source),
    ...loaderFacts(source),
  };
};

/** The frame lifecycle events whose payload carries frame identity. */
export type CdpFrameEventKind =
  | "navigated"
  | "attached"
  | "detached"
  | "within_document"
  | "requested";

/**
 * Parse one frame lifecycle event payload by its declared protocol shape. The
 * CDP event registry (`protocol/CdpEvents.ts`) is the only caller, so every
 * subscriber reads these facts rather than the raw payload.
 */
export const cdpFrameEventPayloadFacts = (
  kind: CdpFrameEventKind,
  rawParams: unknown,
): CdpFrameFacts => {
  const empty: CdpFrameFacts = {
    kind,
    frameId: null,
    identityIssue: null,
    parentRelation: "not_applicable",
    parentId: null,
    parentIssue: null,
    loaderId: undefined,
    loaderIssue: null,
  };
  const params = recordValue(rawParams);
  if (params === undefined)
    return {
      ...empty,
      identityIssue:
        rawParams === undefined ? "missing_params" : "invalid_params",
    };
  if (kind === "navigated")
    return { ...cdpFrameRecordFacts(recordValue(params.frame)), kind };
  const frameId = nonEmptyString(params.frameId) ?? null;
  return {
    kind,
    frameId,
    identityIssue: identityIssueFor(false, undefined, params.frameId),
    ...(kind === "attached"
      ? requiredChildParentFacts(frameId, params.parentFrameId)
      : noParent),
    loaderId: undefined,
    loaderIssue: null,
  };
};
