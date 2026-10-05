import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  readEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { ok } from "../domain/result.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface EvidenceToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
  readonly exportContract: ReturnType<
    typeof toolContract<"export_evidence_bundle">
  >;
  readonly importContract: ReturnType<
    typeof toolContract<"import_evidence_bundle">
  >;
  readonly snapshotContract: ReturnType<
    typeof toolContract<"get_evidence_bundle">
  >;
}

/** Register evidence bundle import and export tools. */
export const registerEvidenceTools = (
  registration: EvidenceToolRegistration,
): void => {
  registerExportEvidenceTool(registration);
  registerImportEvidenceTool(registration);
  registerSnapshotEvidenceTool(registration);
};

const registerExportEvidenceTool = ({
  server,
  session,
  exportContract,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input) => {
      const bundle = session.exportEvidenceBundle();
      const written = await writeEvidenceBundle(
        bundle,
        input.path,
        input.overwrite,
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
    () =>
      toCallToolResult(ok(session.exportEvidenceBundle()), snapshotContract),
  );
};

const registerImportEvidenceTool = ({
  server,
  session,
  importContract,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    importContract.name,
    toolRegistrationOptions(importContract),
    async (input) => {
      const path = input.path;
      const loaded = await readEvidenceBundle(path);
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

interface UnknownToolRegistration {
  readonly server: McpServer;
  readonly session: BinarySessionPort;
}

/** Register residual-unknown query and mutation tools. */
const registerListUnknownsTool = ({
  server,
  session,
}: UnknownToolRegistration): void => {
  const listContract = toolContract("list_unknowns");
  server.registerTool(
    listContract.name,
    toolRegistrationOptions(listContract),
    (input) => {
      const filters = input;
      const all = session.listUnknowns({
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.severity === undefined
          ? {}
          : { severity: filters.severity }),
        ...(filters.domain === undefined ? {} : { domain: filters.domain }),
      });
      return toCallToolResult(
        ok({
          items: all,
          total: all.length,
        }),
        listContract,
      );
    },
  );
};

const registerRecordUnknownTool = ({
  server,
  session,
}: UnknownToolRegistration): void => {
  const recordContract = toolContract("record_unknown");
  server.registerTool(
    recordContract.name,
    toolRegistrationOptions(recordContract),
    (input) => {
      const result = session.recordUnknown(input);
      return toCallToolResult(result, recordContract);
    },
  );
};

const registerUpdateUnknownTool = ({
  server,
  session,
}: UnknownToolRegistration): void => {
  const updateContract = toolContract("update_unknown");
  server.registerTool(
    updateContract.name,
    toolRegistrationOptions(updateContract),
    (input) => {
      const result = session.updateUnknown(input);
      return toCallToolResult(result, updateContract);
    },
  );
};

const registerVerifyUnknownTool = ({
  server,
  session,
}: UnknownToolRegistration): void => {
  const verifyContract = toolContract("verify_unknown_resolution");
  server.registerTool(
    verifyContract.name,
    toolRegistrationOptions(verifyContract),
    (input) =>
      toCallToolResult(
        session.verifyUnknownResolution(input.unknown_id),
        verifyContract,
      ),
  );
};

export const registerUnknownTools = (
  registration: UnknownToolRegistration,
): void => {
  registerListUnknownsTool(registration);
  registerRecordUnknownTool(registration);
  registerUpdateUnknownTool(registration);
  registerVerifyUnknownTool(registration);
};
