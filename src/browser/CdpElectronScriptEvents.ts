import type { CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  boundedText,
  numberValue,
  recordValue,
  stringValue,
} from "./CdpCaptureValues.js";

export interface ElectronScriptDraft {
  readonly scriptId: string;
  readonly rawUrl: string;
  readonly hash: string;
  readonly length: number;
  readonly isModule: boolean;
  readonly language: string | null;
  readonly executionContextKey: string | null;
}

/** Retain only bounded script/frame metadata from passive Electron events. */
export const ingestElectronScriptEvent = (input: {
  readonly event: CdpEvent;
  readonly scripts: ElectronScriptDraft[];
  readonly executionContextFrames: Map<string, string>;
  readonly completeness: CdpCaptureCompleteness;
}): void => {
  if (input.event.method === "Runtime.executionContextsCleared") {
    input.executionContextFrames.clear();
    return;
  }
  if (input.event.method === "Runtime.executionContextDestroyed") {
    const parameters = recordValue(input.event.params);
    const key = executionContextKey(parameters?.executionContextId);
    if (key !== null) input.executionContextFrames.delete(key);
    return;
  }
  if (input.event.method === "Runtime.executionContextCreated") {
    retainExecutionContext(
      input.event,
      input.executionContextFrames,
      input.completeness,
    );
    return;
  }
  if (input.event.method !== "Debugger.scriptParsed") return;
  const value = recordValue(input.event.params);
  const scriptId = stringValue(value?.scriptId);
  const rawUrl = stringValue(value?.url);
  if (scriptId === undefined || scriptId.length > 256) {
    input.completeness.exclude("scripts", "invalid_protocol_value");
    return;
  }
  if (rawUrl === undefined || rawUrl === "") {
    input.completeness.exclude("scripts", "unattributed_origin");
    return;
  }
  if (input.scripts.length >= 2_000) {
    input.completeness.drop("scripts");
    return;
  }
  input.scripts.push({
    scriptId,
    rawUrl,
    hash: (stringValue(value?.hash) ?? "").slice(0, 512),
    length: nonnegativeInteger(value?.length),
    isModule: value?.isModule === true,
    language: boundedText(value?.scriptLanguage, 100),
    executionContextKey: executionContextKey(value?.executionContextId),
  });
};

const retainExecutionContext = (
  event: CdpEvent,
  frames: Map<string, string>,
  completeness: CdpCaptureCompleteness,
): void => {
  const parameters = recordValue(event.params);
  const runtimeContext = recordValue(parameters?.context);
  const contextKey = executionContextKey(runtimeContext?.id);
  const frameId = stringValue(recordValue(runtimeContext?.auxData)?.frameId);
  if (contextKey === null || frameId === undefined || frameId.length > 256)
    return;
  if (frames.size >= 2_000 && !frames.has(contextKey)) {
    completeness.truncate("scripts");
    return;
  }
  frames.set(contextKey, frameId);
};

const nonnegativeInteger = (value: unknown): number => {
  const number = numberValue(value);
  return number === undefined ? 0 : Math.max(0, Math.trunc(number));
};

const executionContextKey = (value: unknown): string | null => {
  const identifier = numberValue(value);
  return identifier !== undefined && Number.isSafeInteger(identifier)
    ? String(identifier)
    : null;
};
