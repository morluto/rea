import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import {
  exportEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
  listUnknownsInputSchema,
  releaseEvidenceBundleInputSchema,
  snapshotEvidenceBundleInputSchema,
  SESSION_TOOL_CONTRACTS,
  verifyUnknownResolutionInputSchema,
} from "../contracts/toolContracts.js";
import type {
  EvidenceBundle,
  EvidenceFilePolicy,
} from "../domain/evidenceBundle.js";
import {
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../domain/residualUnknown.js";
import { err, ok, type Result } from "../domain/result.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface EvidenceToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly exportContract: (typeof SESSION_TOOL_CONTRACTS)[3];
  readonly importContract: (typeof SESSION_TOOL_CONTRACTS)[4];
  readonly snapshotContract: (typeof SESSION_TOOL_CONTRACTS)[19];
  readonly releaseContract: (typeof SESSION_TOOL_CONTRACTS)[20];
  readonly filePolicy: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
}

/** Register evidence bundle import and export tools. */
export const registerEvidenceTools = (
  registration: EvidenceToolRegistration,
): void => {
  registerExportEvidenceTool(registration);
  registerImportEvidenceTool(registration);
  registerSnapshotEvidenceTool(registration);
  registerReleaseEvidenceTool(registration);
};

const registerReleaseEvidenceTool = ({
  server,
  session,
  releaseContract,
  permissionAuthority,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    releaseContract.name,
    toolRegistrationOptions(releaseContract),
    async (input) => {
      const parsed = safeParseToolInput(
        releaseEvidenceBundleInputSchema,
        input,
        releaseContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, releaseContract);
      const denied = await authorizeEvidenceWrite({
        authority: permissionAuthority,
        operationIdentity: `release_evidence:${parsed.value.bundle_digest}`,
      });
      if (denied !== undefined)
        return toCallToolResult(denied, releaseContract);
      return toCallToolResult(
        ok({
          bundle_digest: parsed.value.bundle_digest,
          released: session.releaseEvidenceBundle(parsed.value.bundle_digest),
        }),
        releaseContract,
      );
    },
  );
};

const authorizeEvidenceWrite = async ({
  authority,
  operationIdentity,
}: {
  readonly authority: PermissionAuthority | undefined;
  readonly operationIdentity: string;
}): Promise<Result<never, AnalysisError> | undefined> => {
  if (authority === undefined) return undefined;
  const authorized = await authority.authorize(
    {
      capability: "evidence_write",
      roots: [],
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: operationIdentity,
    },
    "write",
  );
  return authorized.ok ? undefined : permissionFailure(authorized);
};

const registerExportEvidenceTool = ({
  server,
  session,
  exportContract,
  filePolicy,
  permissionAuthority,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        exportEvidenceBundleInputSchema,
        input,
        exportContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, exportContract);
      const parsed = parsedInput.value;
      const bundle = session.exportEvidenceBundle();
      const denied = await authorizeEvidencePath({
        authority: permissionAuthority,
        capability: "evidence_write",
        path: parsed.path,
        access: "write",
        operationIdentity: `export_evidence:${parsed.path}`,
      });
      if (denied !== undefined) return toCallToolResult(denied, exportContract);
      const written = await writeEvidenceBundle(
        bundle,
        parsed.path,
        parsed.overwrite,
        filePolicy,
      );
      return written.ok
        ? toCallToolResult(
            ok({
              path: written.value.path,
              bytes: written.value.bytes,
              records: bundle.records.length,
              unknowns: bundle.unknowns.length,
            }),
            exportContract,
          )
        : toCallToolResult(written, exportContract);
    },
  );
};

const registerSnapshotEvidenceTool = ({
  server,
  session,
  snapshotContract,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    snapshotContract.name,
    toolRegistrationOptions(snapshotContract),
    (input) => {
      const parsed = safeParseToolInput(
        snapshotEvidenceBundleInputSchema,
        input,
        snapshotContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, snapshotContract);
      const snapshot = session.snapshotEvidenceBundle();
      if (!snapshot.ok) return toCallToolResult(snapshot, snapshotContract);
      const value = {
        bundle_digest: snapshot.value.bundleDigest,
        bundle_version: snapshot.value.bundleVersion,
        bytes: snapshot.value.bytes,
        records: snapshot.value.records,
        unknowns: snapshot.value.unknowns,
        scope: snapshot.value.scope,
        survives_session: snapshot.value.survivesSession,
        bundle_uri: snapshot.value.uri,
      } as const;
      return toCallToolResult(ok(value), snapshotContract, {
        resourceLinks: [
          {
            uri: snapshot.value.uri,
            name: snapshot.value.bundleDigest,
            description: "Immutable session-retained Evidence v2 bundle",
          },
        ],
      });
    },
  );
};

const registerImportEvidenceTool = ({
  server,
  session,
  importContract,
  filePolicy,
  permissionAuthority,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    importContract.name,
    toolRegistrationOptions(importContract),
    async (input) => {
      const parsedInput = safeParseToolInput(
        importEvidenceBundleInputSchema,
        input,
        importContract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, importContract);
      const path = parsedInput.value.path;
      const denied = await authorizeEvidencePath({
        authority: permissionAuthority,
        capability: "evidence_read",
        path,
        access: "read",
        operationIdentity: `import_evidence:${path}`,
      });
      if (denied !== undefined) return toCallToolResult(denied, importContract);
      const loaded = await readEvidenceBundle(path, filePolicy);
      if (!loaded.ok) return toCallToolResult(loaded, importContract);
      const retainedUnknownRevisions = new Set(
        session
          .exportEvidenceBundle()
          .unknowns.map((unknown) => unknownRevisionKey(unknown)),
      );
      const imported = session.importEvidenceBundle(loaded.value);
      return imported.ok
        ? toCallToolResult(
            ok({
              imported: imported.value,
              unknowns_added: loaded.value.unknowns.filter(
                (unknown) =>
                  !retainedUnknownRevisions.has(unknownRevisionKey(unknown)),
              ).length,
              total: session.exportEvidenceBundle().records.length,
            }),
            importContract,
          )
        : toCallToolResult(imported, importContract);
    },
  );
};

const unknownRevisionKey = (
  unknown: EvidenceBundle["unknowns"][number],
): string => `${unknown.unknown_id}:${String(unknown.revision)}`;

interface EvidenceAuthorizationInput {
  readonly authority: PermissionAuthority | undefined;
  readonly capability: "evidence_read" | "evidence_write";
  readonly path: string;
  readonly access: "read" | "write";
  readonly operationIdentity: string;
}

const authorizeEvidencePath = async (
  input: EvidenceAuthorizationInput,
): Promise<Result<never, AnalysisError> | undefined> => {
  if (input.authority === undefined) return undefined;
  const authorized = await input.authority.authorize(
    {
      capability: input.capability,
      roots: [input.path],
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: input.operationIdentity,
    },
    input.access,
  );
  return authorized.ok ? undefined : permissionFailure(authorized);
};

interface UnknownToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly contracts: typeof SESSION_TOOL_CONTRACTS;
}

/** Register residual-unknown query and mutation tools. */
export const registerUnknownTools = ({
  server,
  session,
  contracts,
}: UnknownToolRegistration): void => {
  const listContract = contracts[14];
  const recordContract = contracts[15];
  const updateContract = contracts[16];
  const verifyContract = contracts[17];
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input) => {
      const parsed = safeParseToolInput(
        listUnknownsInputSchema,
        input,
        listContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, listContract);
      const filters = parsed.value;
      const all = session.listUnknowns({
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.severity === undefined
          ? {}
          : { severity: filters.severity }),
        ...(filters.domain === undefined ? {} : { domain: filters.domain }),
      });
      const items = all
        .slice(filters.offset, filters.offset + filters.limit)
        .map((unknown) => ({
          unknown,
          uri: `rea://unknown/${unknown.unknown_id}`,
        }));
      const nextOffset =
        filters.offset + items.length < all.length
          ? filters.offset + items.length
          : null;
      return toCallToolResult(
        ok({
          items,
          offset: filters.offset,
          limit: filters.limit,
          total: all.length,
          next_offset: nextOffset,
          has_more: nextOffset !== null,
        }),
        listContract,
        {
          resourceLinks: items.map((unknown) => ({
            uri: unknown.uri,
            name: unknown.unknown.unknown_id,
            description: `Current ${unknown.unknown.status} residual unknown revision`,
          })),
        },
      );
    },
  );
  server.registerTool(
    recordContract.name,
    toolRegistrationOptions(recordContract),
    (input) => {
      const parsed = safeParseToolInput(
        recordUnknownInputSchema,
        input,
        recordContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, recordContract);
      const result = session.recordUnknown(parsed.value);
      return result.ok
        ? toCallToolResult(result, recordContract, {
            resourceLinks: [
              {
                uri: `rea://unknown/${result.value.unknown_id}`,
                name: result.value.unknown_id,
                description: "Current residual unknown head",
              },
            ],
          })
        : toCallToolResult(result, recordContract);
    },
  );
  server.registerTool(
    updateContract.name,
    toolRegistrationOptions(updateContract),
    (input) => {
      const parsed = safeParseToolInput(
        updateUnknownInputSchema,
        input,
        updateContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, updateContract);
      const result = session.updateUnknown(parsed.value);
      if (result.ok)
        void server.server
          .sendResourceUpdated({
            uri: `rea://unknown/${result.value.unknown_id}`,
          })
          .catch(() => undefined);
      return result.ok
        ? toCallToolResult(result, updateContract, {
            resourceLinks: [
              {
                uri: `rea://unknown/${result.value.unknown_id}`,
                name: result.value.unknown_id,
                description: "Updated residual unknown head",
              },
            ],
          })
        : toCallToolResult(result, updateContract);
    },
  );
  server.registerTool(
    verifyContract.name,
    toolRegistrationOptions(verifyContract),
    (input) => {
      const parsed = safeParseToolInput(
        verifyUnknownResolutionInputSchema,
        input,
        verifyContract.name,
      );
      return parsed.ok
        ? toCallToolResult(
            session.verifyUnknownResolution(parsed.value.unknown_id),
            verifyContract,
          )
        : toCallToolResult(parsed, verifyContract);
    },
  );
};

const permissionFailure = (
  failure: Awaited<ReturnType<PermissionAuthority["authorize"]>>,
): Result<never, AnalysisError> => {
  if (failure.ok)
    return err(new AnalysisProtocolError("Expected a denied permission"));
  return err(
    failure.error instanceof PermissionRequiredError
      ? failure.error
      : new AnalysisProtocolError(failure.error.message, {
          cause: failure.error,
        }),
  );
};
