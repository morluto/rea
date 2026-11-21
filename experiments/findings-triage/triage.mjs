import { createHash } from "node:crypto";
import { z } from "zod";
import {
  digestSchema,
  prefixedDigestSchema,
} from "../../dist/domain/digests.js";

const text = z.string().regex(/\S/u, "Expected non-blank text");
// Titles become issue titles and Markdown headings.
const line = text.regex(
  /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u,
  "Expected one line without control characters",
);
// Finding IDs become file names: reject separators, dot-leading names and
// Windows device names, which are reserved even with an extension. Without
// the u flag, case-insensitive matching cannot fold non-ASCII letters into
// the ASCII class.
const findingId = z
  .string()
  .regex(
    /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/i,
    "Expected 1-64 ASCII letters, digits, '.', '_' or '-', starting with a letter or digit, and not a reserved device name",
  );
const severity = z.enum(["low", "medium", "high", "critical"]);

const triageSchema = z.strictObject({
  schema: z.literal("findings-triage/1"),
  title: line,
  target: z.strictObject({
    name: text,
    artifact_digest: digestSchema.nullable(),
  }),
  findings: z.array(
    z.strictObject({
      id: findingId,
      title: line,
      statement: text,
      verdict: z.enum(["defect", "suspect", "acceptable", "unknown"]),
      claim_type: z.enum(["structure", "behavior", "runtime-behavior"]),
      evidence_ids: z
        .array(prefixedDigestSchema("ev"))
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Evidence IDs must be unique",
        ),
      unknown_id: prefixedDigestSchema("unk").optional(),
      severity: severity.optional(),
      disclosure: z.enum(["public", "private"]).optional(),
      impact: text.optional(),
      remediation: text.optional(),
      next_probe: z
        .strictObject({ operation: text, rationale: text })
        .optional(),
    }),
  ),
});

const REQUIRED_FIELDS = {
  defect: ["severity", "disclosure", "impact", "remediation"],
  suspect: ["severity", "disclosure", "impact", "next_probe"],
  unknown: ["next_probe"],
  acceptable: [],
};
// Only these verdicts settle a question; suspect and unknown stay open.
const SETTLED = new Set(["defect", "acceptable"]);
const RUNTIME_AUTHORITIES = new Set(["controlled-replay", "external-service"]);
const SECTIONS = [
  ["defect", "Defects"],
  ["suspect", "Suspects"],
  ["unknown", "Unknowns"],
  ["acceptable", "Acceptable"],
];
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const CONFIDENCE_ORDER = ["observed", "derived", "inferred"];

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Registry mutation records are derived, but they record analyst intent,
// not proof of the answer.
const qualifies = ({ confidence, authority }) =>
  confidence !== "inferred" && authority !== "analyst-inference";

const currentUnknowns = (unknowns) => {
  const heads = new Map();
  for (const unknown of unknowns) {
    const current = heads.get(unknown.unknown_id);
    if (current === undefined || unknown.revision > current.revision)
      heads.set(unknown.unknown_id, unknown);
  }
  return heads;
};

const checkEvidence = (finding, at, context, error) => {
  const cited = [];
  for (const [index, id] of finding.evidence_ids.entries()) {
    const record = context.records.get(id);
    if (record === undefined) {
      error(
        "evidence_not_in_bundle",
        `${at}.evidence_ids.${index}`,
        `${id} is not a record in the bundle`,
      );
      continue;
    }
    cited.push(record);
    const subject = record.subject?.digest.sha256;
    if (
      context.digest !== null &&
      subject !== undefined &&
      subject !== context.digest
    )
      error(
        "evidence_subject_mismatch",
        `${at}.evidence_ids.${index}`,
        `${id} describes artifact ${subject}, not the target`,
      );
  }
  const { verdict } = finding;
  if (verdict !== "unknown" && finding.evidence_ids.length === 0)
    error(
      "finding_without_evidence",
      `${at}.evidence_ids`,
      `A ${verdict} finding must cite Evidence`,
    );
  if (!SETTLED.has(verdict)) return;
  if (!cited.some(qualifies))
    error(
      "verdict_requires_observed_basis",
      `${at}.verdict`,
      `A ${verdict} verdict needs an observed or derived record that is not analyst inference`,
    );
  if (
    finding.claim_type === "runtime-behavior" &&
    !cited.some(
      (record) =>
        qualifies(record) && RUNTIME_AUTHORITIES.has(record.authority),
    )
  )
    error(
      "runtime_claim_without_runtime_authority",
      `${at}.claim_type`,
      `A runtime-behavior ${verdict} needs one observed or derived controlled-replay or external-service record`,
    );
};

const checkUnknown = (finding, at, heads, error) => {
  if (finding.unknown_id === undefined) return;
  const head = heads.get(finding.unknown_id);
  const path = `${at}.unknown_id`;
  if (head === undefined)
    error(
      "unknown_not_in_bundle",
      path,
      `${finding.unknown_id} is not a residual unknown in the bundle`,
    );
  else if (head.status === "resolved")
    error("unknown_resolved", path, `Resolved at revision ${head.revision}`);
  else if (SETTLED.has(finding.verdict))
    error(
      "verdict_conflicts_with_open_unknown",
      path,
      `A ${finding.verdict} verdict cannot rest on an unknown that is ${head.status}`,
    );
};

/** Return the parsed triage (or null) and every problem found. */
export const validate = (input, bundle) => {
  const parsed = triageSchema.safeParse(input);
  if (!parsed.success)
    return {
      triage: null,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_violation",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  const triage = parsed.data;
  const issues = [];
  const error = (code, path, message) => issues.push({ code, path, message });
  const heads = currentUnknowns(bundle.unknowns);
  const context = {
    records: new Map(
      bundle.records.map((record) => [record.evidence_id, record]),
    ),
    digest: triage.target.artifact_digest,
  };
  if (
    context.digest !== null &&
    !bundle.artifacts.some(({ digest }) => digest.sha256 === context.digest)
  )
    error("target_not_in_bundle", "target.artifact_digest", context.digest);
  const ids = new Set();
  for (const [index, finding] of triage.findings.entries()) {
    const at = `findings.${index}`;
    // Case-insensitive file systems would map these IDs to one file.
    const key = finding.id.toLowerCase();
    if (ids.has(key)) error("duplicate_finding_id", `${at}.id`, finding.id);
    ids.add(key);
    checkEvidence(finding, at, context, error);
    checkUnknown(finding, at, heads, error);
    for (const field of REQUIRED_FIELDS[finding.verdict])
      if (finding[field] === undefined)
        error(
          `${field}_missing`,
          `${at}.${field}`,
          `A ${finding.verdict} finding requires ${field}`,
        );
  }
  const linked = new Set(triage.findings.map(({ unknown_id: id }) => id));
  for (const [id, head] of heads)
    if (head.status !== "resolved" && !linked.has(id))
      error(
        "unknown_not_triaged",
        "findings",
        `${id} is ${head.status} and no finding links it`,
      );
  return { triage, issues };
};

// Keyed by target name, not artifact digest, so a problem that survives into
// a new build matches the issue already filed for it.
const fingerprint = (target, findingId) =>
  createHash("sha256")
    .update(`${target.name}\0${findingId}`)
    .digest("hex")
    .slice(0, 16);

const inline = (value) =>
  String(value)
    .replaceAll(/\s*\r?\n\s*/gu, " ")
    .replaceAll("|", "\\|");

// Pad cells so the output is already in oxfmt's aligned table form.
const table = (header, rows) => {
  const cells = [header, ...rows].map((row) => row.map(inline));
  const widths = header.map((_, column) =>
    Math.max(3, ...cells.map((row) => row[column].length)),
  );
  const tableLine = (row) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    tableLine(cells[0]),
    tableLine(widths.map((width) => "-".repeat(width))),
    ...cells.slice(1).map(tableLine),
  ].join("\n");
};

const list = (items) => items.map((item) => `- ${item}`).join("\n");

const strength = (records) => {
  const strongest = CONFIDENCE_ORDER.find((confidence) =>
    records.some((record) => record.confidence === confidence),
  );
  if (strongest === undefined) return "none cited";
  const authorities = [...new Set(records.map(({ authority }) => authority))];
  return `${strongest} (${authorities.sort(compareText).join(", ")})`;
};

const findingBody = (finding, cited) => {
  const facts = [
    `Verdict: ${finding.verdict}`,
    `Claim type: ${finding.claim_type}`,
    finding.severity && `Severity: ${finding.severity}`,
    finding.disclosure && `Disclosure: ${finding.disclosure}`,
    `Strength: ${strength(cited)}`,
    finding.unknown_id && `Residual unknown: \`${finding.unknown_id}\``,
  ];
  return [
    finding.statement,
    list(facts.filter(Boolean)),
    cited.length > 0 &&
      table(
        ["Evidence", "Operation", "Confidence", "Authority"],
        cited.map((record) => [
          `\`${record.evidence_id}\``,
          record.operation,
          record.confidence,
          record.authority,
        ]),
      ),
    finding.impact && `**Impact:** ${finding.impact}`,
    finding.remediation && `**Remediation:** ${finding.remediation}`,
    finding.next_probe &&
      `**Next probe:** \`${finding.next_probe.operation}\`: ${finding.next_probe.rationale}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const severityRank = (finding) =>
  finding.severity === undefined
    ? SEVERITY_ORDER.length
    : SEVERITY_ORDER.indexOf(finding.severity);

const targetLine = ({ name, artifact_digest: digest }) =>
  `${name}, ${digest === null ? "artifact digest not recorded" : `\`sha256:${digest}\``}`;

const evidenceSection = (records) =>
  [...records]
    .sort((left, right) => compareText(left.evidence_id, right.evidence_id))
    .flatMap((record) => [
      `### \`${record.evidence_id}\``,
      list([
        `Operation: ${record.operation}`,
        `Confidence: ${record.confidence}`,
        `Authority: ${record.authority}`,
      ]),
      ...(record.limitations.length > 0
        ? [`Limitations:\n\n${list(record.limitations)}`]
        : []),
    ]);

const unknownsTable = (heads, findings) => {
  const rows = [...heads.values()]
    .sort((left, right) => compareText(left.unknown_id, right.unknown_id))
    .map((head) => {
      const triagedBy = findings
        .filter(({ unknown_id: id }) => id === head.unknown_id)
        .map(({ id }) => id);
      return [
        `\`${head.unknown_id}\``,
        String(head.revision),
        head.resolution === null
          ? head.status
          : `${head.status} (${head.resolution.disposition})`,
        head.severity,
        head.question,
        triagedBy.join(", ") || "none",
      ];
    });
  return table(
    ["Unknown", "Revision", "Status", "Severity", "Question", "Triaged by"],
    rows,
  );
};

/** Render a validated triage as a map of relative output path to content. */
export const render = (triage, bundle, bundleSha256) => {
  const records = new Map(
    bundle.records.map((record) => [record.evidence_id, record]),
  );
  const heads = currentUnknowns(bundle.unknowns);
  const files = new Map();
  const exported = [];
  const citedRecords = new Set();
  const report = [
    `# ${triage.title}`,
    `- Target: ${targetLine(triage.target)}\n- Bundle: \`sha256:${bundleSha256}\`, ${bundle.records.length} Evidence records, ${heads.size} residual unknowns (${bundle.unknowns.length} revisions)`,
    table(
      ["Verdict", "Findings"],
      SECTIONS.map(([verdict]) => [
        verdict,
        String(triage.findings.filter((f) => f.verdict === verdict).length),
      ]),
    ),
  ];
  for (const [verdict, heading] of SECTIONS) {
    const findings = triage.findings
      .filter((finding) => finding.verdict === verdict)
      .sort(
        (left, right) =>
          severityRank(left) - severityRank(right) ||
          compareText(left.id, right.id),
      );
    if (findings.length === 0) continue;
    report.push(`## ${heading}`);
    for (const finding of findings) {
      const cited = finding.evidence_ids.map((id) => records.get(id));
      for (const record of cited) citedRecords.add(record);
      const body = findingBody(finding, cited);
      report.push(`### ${finding.id}: ${finding.title}`, body);
      if (verdict !== "defect" && verdict !== "suspect") continue;
      // Exported bodies are read standalone, so they carry limitations.
      const limitations = [
        ...new Set(cited.flatMap((record) => record.limitations)),
      ];
      const print = fingerprint(triage.target, finding.id);
      const exportedBody = [
        body,
        limitations.length > 0 &&
          `Limitations of the cited Evidence:\n\n${list(limitations)}`,
        `Target: ${targetLine(triage.target)}`,
        `<!-- findings-triage:${print} -->\n`,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (finding.disclosure === "private") {
        files.set(
          `advisories/${finding.id}.md`,
          `# ${finding.title}\n\n${exportedBody}`,
        );
        continue;
      }
      const bodyFile = `issues/${finding.id}.md`;
      files.set(bodyFile, exportedBody);
      exported.push({
        id: finding.id,
        title: finding.title,
        body_file: bodyFile,
        fingerprint: print,
      });
    }
  }
  if (citedRecords.size > 0)
    report.push("## Evidence", ...evidenceSection(citedRecords));
  report.push("## Residual unknowns", unknownsTable(heads, triage.findings));
  files.set("report.md", `${report.join("\n\n")}\n`);
  files.set("issues.json", `${JSON.stringify(exported, null, 2)}\n`);
  return files;
};
