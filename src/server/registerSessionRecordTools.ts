import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { err, ok } from "../domain/result.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { inspectEvidenceBundle } from "../application/investigation/InspectEvidenceBundle.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

interface EvidenceToolRegistration {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort;
  readonly resources: ArtifactResourceScope;
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
  resources,
  exportContract,
}: EvidenceToolRegistration): void => {
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    async (input, context) => {
      const bundle = bundleForSerialization(session);
      const written = await writeEvidenceBundle(
        bundle,
        input.path,
        input.overwrite,
        resources,
        context.mcpReq.signal,
      );
      return written.ok
        ? server.delivery.toCallToolResult(
            ok({
              path: written.value.path,
              bytes: written.value.bytes,
              records: bundle.records.length,
              unknowns: bundle.unknowns.length,
            }),
            exportContract,
          )
        : server.delivery.toCallToolResult(written, exportContract);
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
    (input) =>
      server.delivery.toCallToolResult(
        inspectEvidenceBundle(bundleForSerialization(session), input),
        snapshotContract,
      ),
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
    async (input, context) => {
      const path = input.path;
      const signal = context.mcpReq.signal;
      const loaded = await readImmutableEvidenceBundle(path, signal);
      if (!loaded.ok)
        return server.delivery.toCallToolResult(loaded, importContract);
      const retainedUnknownRevisions = new Set(
        bundleForSerialization(session).unknowns.map((unknown) =>
          unknownRevisionKey(unknown),
        ),
      );
      if (signal.aborted)
        return server.delivery.toCallToolResult(
          err(new AnalysisCancelledError("import_evidence_bundle")),
          importContract,
        );
      const imported = session.importEvidenceBundle(loaded.value);
      return imported.ok
        ? server.delivery.toCallToolResult(
            ok({
              imported: imported.value,
              unknowns_added: loaded.value.unknowns.filter(
                (unknown) =>
                  !retainedUnknownRevisions.has(unknownRevisionKey(unknown)),
              ).length,
              total: bundleForSerialization(session).records.length,
            }),
            importContract,
          )
        : server.delivery.toCallToolResult(imported, importContract);
    },
  );
};

const bundleForSerialization = (session: BinarySessionPort): EvidenceBundle =>
  session.evidenceBundleForSerialization?.() ?? session.exportEvidenceBundle();

const unknownRevisionKey = (
  unknown: EvidenceBundle["unknowns"][number],
): string => `${unknown.unknown_id}:${String(unknown.revision)}`;

interface UnknownToolRegistration {
  readonly server: EvidenceMcpServer;
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
      const all = session.listUnknowns({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.domain === undefined ? {} : { domain: input.domain }),
      });
      return server.delivery.toCallToolResult(
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
      return server.delivery.toCallToolResult(result, recordContract);
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
      return server.delivery.toCallToolResult(result, updateContract);
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
      server.delivery.toCallToolResult(
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
