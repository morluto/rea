import { inferJsonShape, type JsonShape } from "../domain/jsonShape.js";
import {
  recordValue,
  cdpStringValue,
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
  const body = cdpStringValue(result?.body);
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
  const inferred = inferBodyShape(decoded);
  updateResponseBodyShape(state, requestId, inferred.shape);
};

export const requestBodyShape = (
  state: CdpCaptureEventsState,
  request: UnknownRecord,
): NetworkState["body_shapes"] => {
  if (!state.input.include_json_body_shapes)
    return { status: "not_approved", request: null, response: null };
  const body = cdpStringValue(request.postData);
  if (!isJsonContentType(recordValue(request.headers)) || body === undefined)
    return { status: "unavailable", request: null, response: null };
  const inferred = inferBodyShape(body);
  return {
    status: inferred.shape === null ? "unavailable" : "included",
    request: inferred.shape,
    response: null,
  };
};

export const updateResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
  response: JsonShape | null,
): void => {
  const current = state.network.get(requestId);
  if (current === undefined) return;
  const request = current.body_shapes.request;
  const status =
    response !== null
      ? "included"
      : request !== null
        ? "partial"
        : "unavailable";
  state.network.set(requestId, {
    ...current,
    body_shapes: { status, request, response },
  });
};

const inferBodyShape = (text: string): { readonly shape: JsonShape | null } => {
  return { shape: inferJsonShape(text) };
};

const invalidResponseBodyShape = (
  state: CdpCaptureEventsState,
  requestId: string,
): void => {
  updateResponseBodyShape(state, requestId, null);
  state.completeness.exclude("json_body_shapes", "invalid_protocol_value");
};
