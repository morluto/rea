import { inferJsonShape, type JsonShape } from "../domain/jsonShape.js";
import {
  recordValue,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { decodeBase64, isJsonContentType } from "./CdpCaptureEventHelpers.js";
import type { CdpCaptureEventsState } from "./CdpCaptureEventState.js";
import type { NetworkState } from "./CdpCaptureEventTypes.js";

export const ingestResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
  value: unknown,
): void => {
  const result = recordValue(value);
  const body = stringValue(result?.body);
  if (body === undefined) {
    invalidResponseBodyShape(state, requestId);
    return;
  }
  const decoded =
    result?.base64Encoded === true
      ? decodeBase64(body)?.toString("utf8")
      : body;
  if (decoded === undefined) {
    invalidResponseBodyShape(state, requestId);
    return;
  }
  const inferred = inferBodyShape(state, decoded);
  updateResponseBodyShape(state, requestId, inferred.shape, inferred.truncated);
};

export const requestBodyShape = (
  state: CdpCaptureEventsState,
  request: UnknownRecord,
): NetworkState["body_shapes"] => {
  if (!state.input.include_json_body_shapes)
    return { status: "not_approved", request: null, response: null };
  const body = stringValue(request.postData);
  if (!isJsonContentType(recordValue(request.headers)) || body === undefined)
    return { status: "unavailable", request: null, response: null };
  const inferred = inferBodyShape(state, body);
  return {
    status: inferred.truncated
      ? "truncated"
      : inferred.shape === null
        ? "unavailable"
        : "included",
    request: inferred.shape,
    response: null,
  };
};

export const updateResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
  response: JsonShape | null,
  truncated: boolean,
): void => {
  const current = state.network.get(requestId);
  if (current === undefined) return;
  const request = current.body_shapes.request;
  const status =
    truncated || current.body_shapes.status === "truncated"
      ? "truncated"
      : response !== null
        ? "included"
        : request !== null
          ? "partial"
          : "unavailable";
  state.network.set(requestId, {
    ...current,
    body_shapes: { status, request, response },
  });
};

const inferBodyShape = (
  state: CdpCaptureEventsState,
  text: string,
): { readonly shape: JsonShape | null; readonly truncated: boolean } => {
  const bytes = Buffer.byteLength(text);
  const remaining =
    state.input.limits.max_total_json_body_bytes - state.jsonBodyBytes;
  if (bytes > state.input.limits.max_json_body_bytes || bytes > remaining) {
    state.completeness.truncate("json_body_shapes");
    return { shape: null, truncated: true };
  }
  state.jsonBodyBytes += bytes;
  const shape = inferJsonShape(text, {
    maximumBytes: state.input.limits.max_json_body_bytes,
    maximumNodes: state.input.limits.max_json_shape_nodes,
    maximumDepth: state.input.limits.max_json_shape_depth,
  });
  if (shape?.truncated === true)
    state.completeness.truncate("json_body_shapes");
  return { shape, truncated: shape?.truncated === true };
};

const invalidResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
): void => {
  updateResponseBodyShape(state, requestId, null, false);
  state.completeness.exclude("json_body_shapes", "invalid_protocol_value");
};
