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

const evidenceUri = (evidenceId: string): string =>
  `rea://evidence/${evidenceId}`;

/** Expose immutable session-owned Evidence v2 records as MCP resources. */
export const registerEvidenceResources = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  registerReconstructionCoverageResource(server, session);
  registerInvestigationWorkspaceResource(server, session);
  registerSessionEvidenceResource(server, session);
  registerActiveResidualUnknownsResource(server, session);
  registerAnalysisSnapshotResource(server, session);
  registerArtifactPageResource(server, session);
  registerFunctionDossierResource(server, session);
  registerEvidenceSectionResource(server, session);
  registerJavaScriptApplicationGraphResource(server, session);
  registerResidualUnknownResource(server, session);
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
        list: () => ({
          resources: session
            .reconstructionCoverageWorkspaces()
            .map((workspace) => ({
              uri: coverageWorkspaceUri(
                workspace.workspace_id,
                workspace.revision,
              ),
              name: `${workspace.workspace_id} revision ${String(workspace.revision)}`,
              title: `${workspace.name} coverage revision ${String(workspace.revision)}`,
              description:
                "Immutable evidence-backed reconstruction coverage workspace revision.",
              mimeType: "application/json",
            })),
        }),
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
      list: () => ({
        resources: session.investigationWorkspaces().map((workspace) => ({
          uri: workspaceUri(workspace.workspace_id, workspace.revision),
          name: `${workspace.workspace_id} revision ${String(workspace.revision)}`,
          title: `${workspace.name} revision ${String(workspace.revision)}`,
          description: "Immutable CAS-linked investigation workspace revision.",
          mimeType: "application/json",
        })),
      }),
      complete: {
        workspaceId: (prefix) =>
          [
            ...new Set(
              session
                .investigationWorkspaces()
                .map(({ workspace_id }) => workspace_id),
            ),
          ].filter((workspaceId) => workspaceId.startsWith(prefix)),
        revision: (prefix, context) =>
          session
            .investigationWorkspaces()
            .filter(
              ({ workspace_id }) =>
                context?.arguments?.workspaceId === workspace_id,
            )
            .map(({ revision }) => String(revision))
            .filter((revision) => revision.startsWith(prefix)),
      },
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
      list: () => ({
        resources: session.exportEvidenceBundle().records.map((evidence) => ({
          uri: evidenceUri(evidence.evidence_id),
          name: evidence.evidence_id,
          title: `${evidence.operation} evidence`,
          description: `Session-owned Evidence v2 record for ${evidence.operation}.`,
          mimeType: "application/json",
        })),
      }),
      complete: {
        evidenceId: (prefix) =>
          session
            .exportEvidenceBundle()
            .records.map(({ evidence_id }) => evidence_id)
            .filter((evidenceId) => evidenceId.startsWith(prefix)),
      },
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
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(evidence, null, 2),
          },
        ],
      };
    },
  );
};

const registerActiveResidualUnknownsResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "active-residual-unknowns",
    "rea://unknowns/active",
    {
      title: "Active residual unknowns",
      description: "Current unresolved session-owned residual unknown heads.",
      mimeType: "application/json",
    },
    (uri) =>
      jsonResource(
        uri.href,
        session.listUnknowns().filter(({ status }) => status !== "resolved"),
      ),
  );
};

const registerAnalysisSnapshotResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "analysis-snapshot",
    new ResourceTemplate("rea://snapshot/{snapshotDigest}", {
      list: () => {
        const snapshot = session.exportAnalysisSnapshot();
        if (!snapshot.ok) return { resources: [] };
        const digest = contentDigest(snapshot.value);
        return {
          resources: [
            {
              uri: `rea://snapshot/${digest}`,
              name: digest,
              title: "Current analysis snapshot",
              description: "Immutable projection of the current target cache.",
              mimeType: "application/json",
            },
          ],
        };
      },
    }),
    {
      title: "Analysis snapshot",
      description:
        "Current provider-neutral analysis snapshot by content digest.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const requested = stringVariable(variables.snapshotDigest, uri.href);
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok || contentDigest(snapshot.value) !== requested)
        throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, snapshot.value);
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
        evidenceId: (prefix) => evidenceIds(session, prefix),
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
      list: () => ({
        resources: session.listUnknowns().map((unknown) => ({
          uri: `rea://unknown/${unknown.unknown_id}`,
          name: unknown.unknown_id,
          title: unknown.question,
          description: `Current ${unknown.status} residual unknown revision.`,
          mimeType: "application/json",
        })),
      }),
      complete: {
        unknownId: (prefix) =>
          session
            .listUnknowns()
            .map(({ unknown_id }) => unknown_id)
            .filter((unknownId) => unknownId.startsWith(prefix)),
      },
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

const coverageWorkspaceUri = (workspaceId: string, revision: number): string =>
  `rea://reconstruction-coverage/${workspaceId}/revision/${String(revision)}`;

const workspaceUri = (workspaceId: string, revision: number): string =>
  `rea://workspace/${workspaceId}/revision/${String(revision)}`;

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

const evidenceIds = (session: BinarySessionPort, prefix: string): string[] =>
  session
    .exportEvidenceBundle()
    .records.map(({ evidence_id }) => evidence_id)
    .filter((evidenceId) => evidenceId.startsWith(prefix));

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
    return pick(result, ["protocol_events", "shim_events"]);
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

const jsonResource = (uri: string, value: JsonValue) => ({
  contents: [
    {
      uri,
      mimeType: "application/json" as const,
      text: JSON.stringify(value, null, 2),
    },
  ],
});

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
