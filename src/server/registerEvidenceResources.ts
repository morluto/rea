import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import type { BinarySessionPort } from "../application/BinarySessionPort.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { registerJavaScriptApplicationGraphResource } from "./registerJavaScriptApplicationGraphResource.js";
import { registerReconstructionObligationLedgerResource } from "./registerReconstructionObligationLedgerResource.js";
import { registerReconstructionReadinessResource } from "./registerReconstructionReadinessResource.js";
import { jsonResource } from "./resourceResult.js";

/** Expose immutable session-owned Evidence v2 records as MCP resources. */
export const registerEvidenceResources = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  registerReconstructionCoverageResource(server, session);
  registerInvestigationWorkspaceResource(server, session);
  registerSessionEvidenceResource(server, session);
  registerEvidenceBundleResource(server, session);
  registerAnalysisSnapshotResource(server, session);
  registerArtifactPageResource(server, session);
  registerFunctionDossierResource(server, session);
  registerEvidenceSectionResource(server, session);
  registerReconstructionObligationLedgerResource(server, session);
  registerReconstructionReadinessResource(server, session);
  registerJavaScriptApplicationGraphResource(server, session);
  registerResidualUnknownResource(server, session);
  session.onAnalysisSnapshotChanged?.(() => {
    void server.server
      .sendResourceUpdated({ uri: "rea://snapshot/current" })
      .catch(() => undefined);
  });
};

const registerReconstructionCoverageResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "reconstruction-coverage-revision",
    new ResourceTemplate(
      "rea://reconstruction-coverage/{workspaceId}/revision/{revision}",
      {
        list: undefined,
      },
    ),
    {
      title: "Reconstruction coverage revision",
      description:
        "Canonical CAS-linked surfaces, owners, claims, verifiers, evidence, and completion boundaries.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const workspaceId = stringVariable(variables.workspaceId, uri.href);
      const revisionText = stringVariable(variables.revision, uri.href);
      if (!/^\d+$/u.test(revisionText))
        throw new ResourceNotFoundError(uri.href);
      const workspace = session.reconstructionCoverageWorkspace(
        workspaceId,
        Number(revisionText),
      );
      if (workspace === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, workspace);
    },
  );
};

const registerInvestigationWorkspaceResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "investigation-workspace-revision",
    new ResourceTemplate("rea://workspace/{workspaceId}/revision/{revision}", {
      list: undefined,
    }),
    {
      title: "Investigation workspace revision",
      description: "Immutable session-retained workspace with CAS linkage.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const workspaceId = stringVariable(variables.workspaceId, uri.href);
      const revisionText = stringVariable(variables.revision, uri.href);
      if (!/^\d+$/u.test(revisionText))
        throw new ResourceNotFoundError(uri.href);
      const workspace = session.investigationWorkspace(
        workspaceId,
        Number(revisionText),
      );
      if (workspace === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, workspace);
    },
  );
};

const registerSessionEvidenceResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "session-evidence",
    new ResourceTemplate("rea://evidence/{evidenceId}", {
      list: undefined,
    }),
    {
      title: "Session evidence",
      description: "Immutable Evidence v2 records owned by this REA session.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const evidenceId = variables.evidenceId;
      if (typeof evidenceId !== "string")
        throw new ResourceNotFoundError(uri.href);
      const evidence = session.evidenceById(evidenceId);
      if (evidence === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, evidence);
    },
  );
};

const registerEvidenceBundleResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "evidence-bundle",
    new ResourceTemplate("rea://evidence-bundle/{bundleDigest}", {
      list: undefined,
    }),
    {
      title: "Evidence bundle",
      description: "Immutable session-retained canonical Evidence v2 bundle.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const digest = stringVariable(variables.bundleDigest, uri.href);
      if (!/^[a-f0-9]{64}$/u.test(digest))
        throw new ResourceNotFoundError(uri.href);
      const text = session.retainedEvidenceBundle(digest);
      if (text === undefined) throw new ResourceNotFoundError(uri.href);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text,
          },
        ],
      };
    },
  );
};

const registerAnalysisSnapshotResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "analysis-snapshot",
    "rea://snapshot/current",
    {
      title: "Analysis snapshot",
      description:
        "Mutable provider-neutral analysis snapshot for the current native target.",
      mimeType: "application/json",
    },
    (uri) => {
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok)
        return jsonResource(uri.href, {
          state: "unavailable",
          reason: snapshot.error.message,
          remediation:
            "Open a native target with a concrete analysis profile. After metadata mutation, call open_binary again for the current target to begin a fresh cache.",
        });
      return jsonResource(uri.href, {
        state: "available",
        target: snapshot.value.target,
        profile: snapshot.value.binding,
        content_digest: contentDigest(snapshot.value),
        entry_count: snapshot.value.entries.length,
        snapshot: snapshot.value,
      });
    },
  );
};

const registerArtifactPageResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "artifact-page",
    new ResourceTemplate("rea://artifact/{manifestId}/{collection}", {
      list: undefined,
      complete: {
        collection: (prefix) =>
          ["nodes", "occurrences", "edges"].filter((value) =>
            value.startsWith(prefix),
          ),
      },
    }),
    {
      title: "Artifact graph page",
      description: "Deterministically paged artifact graph collection.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const manifestId = stringVariable(variables.manifestId, uri.href);
      const collection = stringVariable(variables.collection, uri.href);
      if (!ARTIFACT_COLLECTIONS.has(collection))
        throw new ResourceNotFoundError(uri.href);
      const evidence = session
        .exportEvidenceBundle()
        .records.find(
          (record) =>
            artifactManifestId(record.normalized_result) === manifestId,
        );
      if (evidence === undefined) throw new ResourceNotFoundError(uri.href);
      const result = objectValue(evidence.normalized_result);
      const page = result?.[collection];
      if (page === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, {
        evidence_id: evidence.evidence_id,
        manifest_id: manifestId,
        collection,
        page,
        provider: evidence.provider,
        limitations: evidence.limitations,
      });
    },
  );
};

const registerFunctionDossierResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "function-dossier",
    new ResourceTemplate("rea://function/{targetSha256}/{address}", {
      list: undefined,
    }),
    {
      title: "Function dossier",
      description: "Session-owned analyze_function dossier with provenance.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const targetSha256 = stringVariable(variables.targetSha256, uri.href);
      const address = stringVariable(variables.address, uri.href);
      const evidence = session
        .exportEvidenceBundle()
        .records.find(
          (record) =>
            record.operation === "analyze_function" &&
            record.subject?.digest.sha256 === targetSha256 &&
            functionAddress(record.normalized_result) === address,
        );
      if (evidence === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, evidence);
    },
  );
};

const registerEvidenceSectionResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "evidence-section",
    new ResourceTemplate("rea://evidence/{evidenceId}/section/{section}", {
      list: undefined,
      complete: {
        section: (prefix) =>
          EVIDENCE_SECTIONS.filter((section) => section.startsWith(prefix)),
      },
    }),
    {
      title: "Evidence section",
      description:
        "One independently useful bounded section of session Evidence v2.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const evidenceId = stringVariable(variables.evidenceId, uri.href);
      const section = stringVariable(variables.section, uri.href);
      const evidence = session.evidenceById(evidenceId);
      if (evidence === undefined) throw new ResourceNotFoundError(uri.href);
      const value = evidenceSection(evidence.normalized_result, section);
      if (value === undefined) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, {
        evidence_id: evidence.evidence_id,
        operation: evidence.operation,
        authority: evidence.authority,
        confidence: evidence.confidence,
        provider: evidence.provider,
        limitations: evidence.limitations,
        section,
        value,
      });
    },
  );
};

const registerResidualUnknownResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "residual-unknown",
    new ResourceTemplate("rea://unknown/{unknownId}", {
      list: undefined,
    }),
    {
      title: "Residual unknown",
      description: "Current session-owned residual unknown head.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const unknownId = stringVariable(variables.unknownId, uri.href);
      const unknown = session
        .listUnknowns()
        .find(({ unknown_id }) => unknown_id === unknownId);
      if (unknown === undefined) throw new ResourceNotFoundError(uri.href);
      const history = session
        .exportEvidenceBundle()
        .unknowns.filter(({ unknown_id }) => unknown_id === unknownId);
      return jsonResource(uri.href, { current: unknown, history });
    },
  );
};

const EVIDENCE_SECTIONS = [
  "result",
  "terminal",
  "filesystem",
  "process",
  "protocol",
  "nodes",
  "occurrences",
  "edges",
] as const;

const stringVariable = (value: unknown, uri: string): string => {
  if (typeof value !== "string") throw new ResourceNotFoundError(uri);
  return value;
};

const evidenceSection = (
  result: JsonValue,
  section: string,
): JsonValue | undefined => {
  if (section === "result") return result;
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return undefined;
  if (section === "terminal")
    return pick(result, ["frames", "rendered_frames", "interaction_events"]);
  if (section === "filesystem")
    return pick(result, [
      "filesystem_checkpoints",
      "filesystem_effects",
      "files_before",
      "files_after",
    ]);
  if (section === "process")
    return pick(result, ["process_samples", "exit", "settlement", "cleanup"]);
  if (section === "protocol")
    return pick(result, [
      "protocol_events",
      "replay_transitions",
      "shim_events",
    ]);
  const value = result[section];
  return value === undefined ? undefined : value;
};

const pick = (
  result: Readonly<Record<string, JsonValue>>,
  names: readonly string[],
): JsonValue | undefined => {
  const entries = names.flatMap((name) =>
    result[name] === undefined ? [] : [[name, result[name]] as const],
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const ARTIFACT_COLLECTIONS = new Set(["nodes", "occurrences", "edges"]);

const objectValue = (
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const artifactManifestId = (value: JsonValue): string | undefined => {
  const manifest = objectValue(objectValue(value)?.manifest ?? null);
  return typeof manifest?.manifest_id === "string"
    ? manifest.manifest_id
    : undefined;
};

const functionAddress = (value: JsonValue): string | undefined => {
  const result = objectValue(value);
  const procedure = objectValue(result?.procedure ?? null);
  const candidate = procedure?.address ?? result?.address;
  return typeof candidate === "string" ? candidate : undefined;
};

const contentDigest = (value: JsonValue): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Resource is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};
