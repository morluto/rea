import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  type ElectronPageInspection,
  type ElectronTargetList,
  type InspectElectronPageInput,
  type ListElectronTargetsInput,
} from "../domain/electronObservation.js";
import {
  AnalysisError,
  BrowserObservationError,
  ProviderAdapterError,
  type BrowserObservationOperation,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  discoverCdpEndpoint,
  hasCdpTargetWebSocket,
  type CdpEndpointTarget,
} from "./CdpEndpoint.js";
import {
  closeCdpTargetSession,
  openCdpTargetSession,
  type CdpTargetSession,
} from "./CdpTargetSession.js";
import { inspectCdpElectronPage } from "./CdpElectronInspection.js";
import {
  authorizedElectronFile,
  canonicalElectronRoots,
} from "./ElectronFileScope.js";

const IDENTITY: ProviderIdentity = {
  id: "rea-cdp-electron",
  name: "REA Electron file-page CDP observation provider",
  version: "1",
};

/** Passive Electron provider with canonical file-root confinement. */
export class CdpElectronProvider implements ElectronObservationPort {
  identity(): ProviderIdentity {
    return IDENTITY;
  }

  async listTargets(
    input: ListElectronTargetsInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronTargetList, AnalysisError>> {
    try {
      const roots = await canonicalElectronRoots(input.allowed_file_roots);
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "list_electron_targets",
        options.signal,
      );
      const allowed = [];
      let outsideRoot = 0;
      let unsupportedUrl = 0;
      let nonPage = 0;
      let unconnectable = 0;
      for (const target of discovery.targets) {
        if (target.type !== "page") {
          nonPage += 1;
          continue;
        }
        const path = await authorizedElectronFile(target.url, roots);
        if (path === undefined) {
          if (isFileUrl(target.url)) outsideRoot += 1;
          else unsupportedUrl += 1;
          continue;
        }
        if (!hasCdpTargetWebSocket(discovery, target)) {
          unconnectable += 1;
          continue;
        }
        allowed.push({
          target_id: target.id,
          type: target.type,
          title: target.title.slice(0, 16_384),
          file_path: path,
          attached: target.attached,
        });
      }
      allowed.sort((left, right) =>
        left.target_id.localeCompare(right.target_id),
      );
      const items = allowed.slice(input.offset, input.offset + input.limit);
      const next = input.offset + items.length;
      return ok(
        electronTargetListSchema.parse({
          schema_version: 1,
          browser: discovery.version,
          targets: {
            items,
            offset: input.offset,
            limit: input.limit,
            total: allowed.length,
            next_offset: next < allowed.length ? next : null,
            has_more: next < allowed.length,
          },
          excluded: {
            outside_root: outsideRoot,
            unsupported_url: unsupportedUrl,
            non_page: nonPage,
          },
          limitations: [
            "Only page targets whose canonical file path is contained by an approved root are listed.",
            ...(unconnectable === 0
              ? []
              : [
                  `${String(unconnectable)} otherwise allowed page target(s) lacked a validated direct CDP WebSocket and were excluded.`,
                ]),
          ],
        }),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "list_electron_targets"));
    }
  }

  async inspectPage(
    input: InspectElectronPageInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronPageInspection, AnalysisError>> {
    let targetSession: CdpTargetSession | undefined;
    try {
      const roots = await canonicalElectronRoots(input.allowed_file_roots);
      const discovery = await discoverCdpEndpoint(
        input.cdp_endpoint,
        "inspect_electron_page",
        options.signal,
      );
      const target = await authorizeTarget(
        discovery.targets,
        input.target_id,
        roots,
      );
      targetSession = await openCdpTargetSession(
        discovery,
        target,
        "inspect_electron_page",
        options.signal,
      );
      return ok(
        electronPageInspectionSchema.parse(
          await inspectCdpElectronPage({
            connection: targetSession.connection,
            sessionId: targetSession.sessionId,
            discovery,
            target,
            input,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.progress === undefined
              ? {}
              : { progress: options.progress }),
          }),
        ),
      );
    } catch (cause: unknown) {
      return err(providerError(cause, "inspect_electron_page"));
    } finally {
      if (targetSession !== undefined)
        await closeCdpTargetSession(targetSession, ["Debugger", "Page"]);
    }
  }
}

const authorizeTarget = async (
  targets: readonly CdpEndpointTarget[],
  targetId: string,
  roots: readonly string[],
): Promise<CdpEndpointTarget> => {
  const target = targets.find(({ id }) => id === targetId);
  if (target === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_found");
  if (
    target.type !== "page" ||
    (await authorizedElectronFile(target.url, roots)) === undefined
  )
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return target;
};

const isFileUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "file:";
  } catch {
    return false;
  }
};

const providerError = (
  cause: unknown,
  operation: BrowserObservationOperation,
): AnalysisError =>
  cause instanceof BrowserObservationError && cause.operation !== operation
    ? new BrowserObservationError(operation, cause.reason, { cause })
    : cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(IDENTITY.id, operation, { cause });
