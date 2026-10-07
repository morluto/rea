import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/javascript/electronObservation.js";
import type { CdpConnection } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  recordValue,
  recordsValue,
  cdpStringValue,
} from "./CdpCaptureValues.js";
import type { CdpEndpointTarget } from "./CdpEndpoint.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import { authorizedElectronFile } from "./ElectronFileScope.js";

/** Inventory local worker targets without attaching to them. */
export const captureElectronWorkers = async (input: {
  readonly connection: CdpConnection;
  readonly signal?: AbortSignal;
  readonly target: CdpEndpointTarget;
  readonly request: InspectElectronPageInput;
  readonly frameIds: ReadonlySet<string>;
  readonly completeness: CdpCaptureCompleteness;
  readonly limitations: string[];
}): Promise<ElectronPageInspection["workers"]> => {
  const result = await optionalCdpCommand(
    {
      connection: input.connection,
      sessionId: undefined,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    "Target.getTargets",
    {},
    input.limitations,
  );
  if (result === undefined) {
    input.completeness.unavailable("workers");
    return [];
  }
  const workers: ElectronPageInspection["workers"] = [];
  for (const target of recordsValue(recordValue(result)?.targetInfos)) {
    const type = cdpStringValue(target.type) ?? "";
    if (!type.includes("worker")) continue;
    const openerTargetId = boundedTargetField(target.openerId);
    const parentFrameId = boundedTargetField(target.parentFrameId);
    if (
      openerTargetId !== input.target.id &&
      (parentFrameId === null || !input.frameIds.has(parentFrameId))
    ) {
      input.completeness.exclude("workers", "out_of_target_scope");
      continue;
    }
    const path = await authorizedElectronFile(cdpStringValue(target.url) ?? "");
    if (path === undefined) {
      input.completeness.exclude("workers", "out_of_target_scope");
      continue;
    }
    const targetId = boundedTargetField(target.targetId);
    if (targetId === null) {
      input.completeness.exclude("workers", "invalid_protocol_value");
      continue;
    }
    workers.push({
      target_id: targetId,
      type,
      file_path: path,
      attached: target.attached === true,
      opener_target_id: openerTargetId,
      parent_frame_id: parentFrameId,
    });
  }
  return workers.sort((left, right) =>
    left.target_id.localeCompare(right.target_id),
  );
};

const boundedTargetField = (value: unknown): string | null => {
  const field = cdpStringValue(value);
  return field === undefined || field === "" ? null : field;
};
