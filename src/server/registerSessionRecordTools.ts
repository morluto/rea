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
  SESSION_TOOL_CONTRACTS,
  verifyUnknownResolutionInputSchema,
} from "../contracts/toolContracts.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
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
  readonly filePolicy: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
}

/** Register evidence bundle import and export tools. */
export const registerEvidenceTools = (
  registration: EvidenceToolRegistration,
): void => {
  registerExportEvidenceTool(registration);
  registerImportEvidenceTool(registration);
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
      if (parsed.path === undefined)
        return toCallToolResult(ok(bundle), exportContract);
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
            }),
            exportContract,
          )
        : toCallToolResult(written, exportContract);
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
      const imported = session.importEvidenceBundle(loaded.value);
      if (imported.ok && imported.value > 0) server.sendResourceListChanged();
      return imported.ok
        ? toCallToolResult(
            ok({
              imported: imported.value,
              total: session.exportEvidenceBundle().records.length,
            }),
            importContract,
          )
        : toCallToolResult(imported, importContract);
    },
  );
};

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
      return toCallToolResult(
        ok(
          session.listUnknowns({
            ...(filters.status === undefined ? {} : { status: filters.status }),
            ...(filters.severity === undefined
              ? {}
              : { severity: filters.severity }),
            ...(filters.domain === undefined ? {} : { domain: filters.domain }),
          }),
        ),
        listContract,
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
      if (result.ok) server.sendResourceListChanged();
      return toCallToolResult(result, recordContract);
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
      if (result.ok) server.sendResourceListChanged();
      return toCallToolResult(result, updateContract);
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
