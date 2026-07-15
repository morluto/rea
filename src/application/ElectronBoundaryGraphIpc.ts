import type { ApplicationNode } from "../domain/javascriptApplicationGraph.js";
import type { ElectronSenderValidationFinding } from "../domain/electronStaticAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import {
  artifactLocalIdentity,
  javascriptAnalysisCoverage,
  type JavaScriptArtifactGraphContext,
  type JavaScriptArtifactGraphCoverage,
} from "./JavaScriptArtifactGraphContext.js";
import { astObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";
import {
  collectElectronIpcRecords,
  unambiguousElectronIpcPairings,
  type ElectronIpcRecord,
} from "./ElectronBoundaryAnalysis.js";
import {
  addElectronAstEdge,
  addElectronInferenceEdge,
  electronFindingSourceNode,
  electronObservationIdentity,
  electronRangeContains,
  electronRangeKey,
} from "./ElectronBoundaryGraphContext.js";

interface IpcGraphState {
  readonly context: JavaScriptArtifactGraphContext;
  readonly records: readonly ElectronIpcRecord[];
  readonly channels: Map<string, ApplicationNode>;
  readonly handlers: Map<string, ApplicationNode>;
  readonly sources: Map<string, ApplicationNode>;
}

interface IpcHandlerInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly record: ElectronIpcRecord;
  readonly source: ApplicationNode;
  readonly channel: ApplicationNode;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

interface ValidationObservationInput {
  readonly context: JavaScriptArtifactGraphContext;
  readonly file: JavaScriptArtifactFile;
  readonly validation: ElectronSenderValidationFinding;
  readonly target: ApplicationNode;
  readonly coverage: JavaScriptArtifactGraphCoverage;
}

/** Project IPC syntax, handler locations, validations, and exact pairings. */
export const addElectronIpcBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  const state: IpcGraphState = {
    context,
    records: collectElectronIpcRecords(context.analysis),
    channels: new Map(),
    handlers: new Map(),
    sources: new Map(),
  };
  for (const record of state.records) addIpcRecord(state, record);
  addValidationObservations(state);
  addLiteralPairings(state);
};

const addIpcRecord = (
  state: IpcGraphState,
  record: ElectronIpcRecord,
): void => {
  const { context } = state;
  const coverage = coverageFor(context, record.file);
  if (coverage === undefined) return;
  const source = electronFindingSourceNode(
    context,
    record.file,
    record.finding.module_key,
  );
  if (source === undefined) return;
  state.sources.set(record.key, source);
  const channel = addChannelNode(context, record, coverage);
  state.channels.set(record.key, channel);
  if (record.finding.mode === "listen" || record.finding.mode === "handle") {
    const handler = addHandlerNode({
      context,
      record,
      source,
      channel,
      coverage,
    });
    state.handlers.set(record.key, handler);
    return;
  }
  addElectronInferenceEdge(context, {
    source,
    target: channel,
    file: record.file,
    range: record.finding.location,
    coverage,
    relation: record.finding.mode === "invoke" ? "invokes" : "sends",
    operation: "map-ipc-transmission",
    properties: {
      side: record.finding.side,
      operation: record.finding.operation,
      channel: record.finding.channel,
      channel_expression: record.finding.channel_expression,
      resolution: record.finding.channel === null ? "dynamic" : "literal",
    },
  });
};

const addChannelNode = (
  context: JavaScriptArtifactGraphContext,
  record: ElectronIpcRecord,
  coverage: JavaScriptArtifactGraphCoverage,
): ApplicationNode => {
  const { finding, file } = record;
  const identityKey =
    finding.channel === null
      ? `dynamic:${record.key}`
      : `literal:${finding.channel}`;
  return context.accumulator.addNode({
    kind: "ipc-channel",
    identity: electronObservationIdentity(
      context,
      "electron-ipc-channel",
      identityKey,
    ),
    observations: [
      {
        label: finding.channel ?? finding.channel_expression,
        properties: {
          side: finding.side,
          operation: finding.operation,
          mode: finding.mode,
          channel: finding.channel,
          channel_expression: finding.channel_expression,
          resolution: finding.channel === null ? "dynamic" : "literal",
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: finding.location,
          operation: "observe-ipc-channel-expression",
          coverage,
          limitations:
            finding.channel === null
              ? [
                  "The channel expression is dynamic; its runtime value and pairings remain unknown.",
                ]
              : [],
        }),
      },
    ],
  });
};

const addHandlerNode = (input: IpcHandlerInput): ApplicationNode => {
  const { context, record, source, channel, coverage } = input;
  const { finding, file } = record;
  const handlerRange = finding.handler_location ?? finding.location;
  const handler = context.accumulator.addNode({
    kind: "ipc-handler",
    identity: artifactLocalIdentity(
      file.sha256,
      "electron-ipc-handler",
      `${finding.side}:${finding.operation}:${finding.channel ?? finding.channel_expression ?? "[missing]"}:${electronRangeKey(handlerRange)}`,
    ),
    observations: [
      {
        label: finding.channel,
        properties: {
          side: finding.side,
          operation: finding.operation,
          mode: finding.mode,
          channel: finding.channel,
          channel_expression: finding.channel_expression,
          handler_kind: finding.handler_kind,
          handler_location: finding.handler_location,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: handlerRange,
          operation: "observe-ipc-handler",
          coverage,
        }),
      },
    ],
  });
  addElectronAstEdge(context, {
    source,
    target: handler,
    file,
    range: handlerRange,
    coverage,
    relation: "contains",
    operation: "locate-ipc-handler",
    properties: { side: finding.side, operation: finding.operation },
  });
  addElectronInferenceEdge(context, {
    source: handler,
    target: channel,
    file,
    range: finding.location,
    coverage,
    relation: "handles",
    operation: "map-ipc-handler-registration",
    properties: {
      channel: finding.channel,
      channel_expression: finding.channel_expression,
      resolution: finding.channel === null ? "dynamic" : "literal",
    },
  });
  return handler;
};

const addLiteralPairings = (state: IpcGraphState): void => {
  for (const pairing of unambiguousElectronIpcPairings(state.records)) {
    const source = state.sources.get(pairing.transmission.key);
    const handler = state.handlers.get(pairing.handler.key);
    const coverage = coverageFor(state.context, pairing.transmission.file);
    if (source === undefined || handler === undefined || coverage === undefined)
      continue;
    addElectronInferenceEdge(state.context, {
      source,
      target: handler,
      file: pairing.transmission.file,
      range: pairing.transmission.finding.location,
      coverage,
      relation:
        pairing.transmission.finding.mode === "invoke" ? "invokes" : "sends",
      operation: "pair-ipc-literal-channel",
      properties: {
        channel: pairing.transmission.finding.channel,
        pairing_basis: "unique-exact-literal-channel",
        handler_path: pairing.handler.file.path,
        handler_operation: pairing.handler.finding.operation,
      },
      limitations: [
        "Literal channel equality does not prove that the handler is registered or reachable at runtime.",
      ],
    });
  }
};

const addValidationObservations = (state: IpcGraphState): void => {
  for (const analyzed of state.context.analysis.files) {
    const { file, javascript } = analyzed;
    if (javascript === null) continue;
    const coverage = javascriptAnalysisCoverage(
      javascript,
      state.context.input,
    );
    for (const validation of javascript.electron.sender_validations) {
      const handlerRecord = containingHandler(state.records, file, validation);
      const target =
        handlerRecord === undefined
          ? electronFindingSourceNode(
              state.context,
              file,
              validation.module_key,
            )
          : state.handlers.get(handlerRecord.key);
      if (target !== undefined)
        addValidationObservation({
          context: state.context,
          file,
          validation,
          target,
          coverage,
        });
    }
  }
};

const addValidationObservation = (input: ValidationObservationInput): void => {
  const { context, file, validation, target, coverage } = input;
  context.accumulator.addNode({
    kind: target.kind,
    identity: target.identity,
    observations: [
      {
        label: `${validation.subject} validation candidate`,
        properties: {
          fact_kind: "sender-validation-candidate",
          subject: validation.subject,
          mechanism: validation.mechanism,
          expected: validation.expected,
          enforcement: validation.enforcement,
        },
        evidence: astObservationEvidence({
          sha256: file.sha256,
          path: file.path,
          range: validation.location,
          operation: "observe-ipc-sender-validation-candidate",
          coverage,
          limitations: [
            "A comparison or string check is visible, but static syntax alone does not prove rejection, ordering, or complete sender validation.",
          ],
        }),
      },
    ],
  });
};

const containingHandler = (
  records: readonly ElectronIpcRecord[],
  file: JavaScriptArtifactFile,
  validation: ElectronSenderValidationFinding,
): ElectronIpcRecord | undefined =>
  records
    .filter(
      (record) =>
        record.file.path === file.path &&
        record.finding.handler_location !== null &&
        electronRangeContains(
          record.finding.handler_location,
          validation.location,
        ),
    )
    .sort(
      (left, right) =>
        rangeMagnitude(left.finding.handler_location) -
        rangeMagnitude(right.finding.handler_location),
    )[0];

const rangeMagnitude = (
  range: ElectronIpcRecord["finding"]["handler_location"],
): number =>
  range === null
    ? Number.MAX_SAFE_INTEGER
    : (range.end.line - range.start.line) * 1_000_000 +
      range.end.column -
      range.start.column;

const coverageFor = (
  context: JavaScriptArtifactGraphContext,
  file: JavaScriptArtifactFile,
): JavaScriptArtifactGraphCoverage | undefined => {
  const javascript = context.analysis.files.find(
    ({ file: candidate }) => candidate.path === file.path,
  )?.javascript;
  return javascript === null || javascript === undefined
    ? undefined
    : javascriptAnalysisCoverage(javascript, context.input);
};
