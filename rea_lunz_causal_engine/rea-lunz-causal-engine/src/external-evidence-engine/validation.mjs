import { canonicalJson, hostOf, isAllowedUrl, independentDomain, normalizeHost, sha256 } from './security.mjs';

const SOURCE_TYPES = new Set(['osv_advisory', 'deps_dev', 'npm_registry', 'github_api', 'official_docs', 'web_page', 'search_snippet']);

const RELATIONS = new Set([
  'evidence_for',
  'supports_hypothesis',
  'contradicts_hypothesis',
  'mentions_entity',
  'declares_dependency',
  'affects_package_version',
  'candidate_causal_link',
  'observed_in',
  'corroborates',
  'same_identifier'
]);

const finiteUnit = value => Number.isFinite(value) && value >= 0 && value <= 1;

export const sourceIdentity = source => `src_${sha256(canonicalJson({
  url: source.url,
  title: source.title,
  source_type: source.source_type,
  retrieved_at: source.retrieved_at,
  excerpt_hash: source.excerpt_hash,
  entity: source.entity ?? null
})).slice(0, 24)}`;

export const validateEvidenceGraph = (graph, options = {}) => {
  const allowedDomains = options.allowedDomains;
  const errors = [];
  const warnings = [];
  const rejectedEvidenceIds = [];
  const acceptedEvidenceIds = [];
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return {
    valid: false,
    status: 'rejected',
    errors: ['graph_not_object'],
    warnings,
    accepted_evidence_ids: acceptedEvidenceIds,
    rejected_evidence_ids: rejectedEvidenceIds,
    validated_claim_count: 0,
    rejected_edge_count: 0,
    contradiction_count: 0,
    independent_source_domains: 0
  };
  if (graph.schema_version !== 'rea-lunz.external-evidence-graph.v1') errors.push('unsupported_schema_version');
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const sources = Array.isArray(graph.sources) ? graph.sources : [];
  if (nodes.length > 5000 || edges.length > 10000 || sources.length > 500) return {
    valid: false,
    status: 'rejected',
    errors: ['graph_resource_limit_exceeded'],
    warnings,
    accepted_evidence_ids: acceptedEvidenceIds,
    rejected_evidence_ids: rejectedEvidenceIds,
    validated_claim_count: 0,
    rejected_edge_count: edges.length,
    contradiction_count: 0,
    independent_source_domains: 0
  };
  const nodeIds = new Set();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length > 300 || typeof node.type !== 'string' || node.type.length > 100 || (typeof node.label === 'string' && node.label.length > 3000)) {
      errors.push('invalid_node_shape');
      continue;
    }
    if (nodeIds.has(node.id)) errors.push(`duplicate_node:${node.id}`);
    nodeIds.add(node.id);
  }
  const sourceMap = new Map();
  const domains = new Set();
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || source.id.length > 200 || typeof source.url !== 'string' || source.url.length > 2048 || typeof source.title !== 'string' || source.title.length > 240 || typeof source.source_type !== 'string' || typeof source.retrieved_at !== 'string' || typeof source.excerpt !== 'string' || typeof source.excerpt_hash !== 'string') {
      rejectedEvidenceIds.push(typeof source?.id === 'string' ? source.id : 'unknown_source');
      errors.push('invalid_source_shape');
      continue;
    }
    let rejection;
    if (sourceMap.has(source.id)) rejection = 'duplicate_source_id';
    else if (!SOURCE_TYPES.has(source.source_type)) rejection = 'source_type_not_allowlisted';
    else if (!isAllowedUrl(source.url, allowedDomains)) rejection = 'source_url_not_allowlisted_https';
    else if (source.domain !== hostOf(source.url) || normalizeHost(source.domain) !== source.domain) rejection = 'source_domain_mismatch';
    else if (!Number.isFinite(Date.parse(source.retrieved_at))) rejection = 'invalid_source_timestamp';
    else if (source.excerpt.length > 1800) rejection = 'source_excerpt_limit_exceeded';
    else if (sha256(source.excerpt) !== source.excerpt_hash) rejection = 'source_excerpt_hash_mismatch';
    else if (source.id !== sourceIdentity(source)) rejection = 'source_identity_mismatch';
    else if (['npm_registry', 'deps_dev', 'osv_advisory'].includes(source.source_type) && source.entity?.exact_match !== true) rejection = 'api_entity_match_not_exact';
    else if (['web_page', 'official_docs', 'search_snippet'].includes(source.source_type) && source.match_score < 0.3) rejection = 'source_relevance_below_floor';
    else if (!source.title || !source.excerpt.trim()) rejection = 'source_has_no_content';
    else if (!finiteUnit(source.reliability) || !finiteUnit(source.match_score) || !finiteUnit(source.quality_score) || !finiteUnit(source.freshness_score) || !finiteUnit(source.trust_cap)) rejection = 'invalid_source_score';
    else if (source.quality_score > Math.min(1, source.reliability * source.match_score * Math.max(0.55, source.freshness_score ?? 1) + 0.03)) rejection = 'source_score_exceeds_derivation_bound';
    if (rejection) {
      rejectedEvidenceIds.push(source.id);
      errors.push(`${rejection}:${source.id}`);
      continue;
    }
    if (options.requireRegisteredSources === true) {
      const registered = options.knownSources instanceof Map ? options.knownSources.get(source.id) : undefined;
      if (registered === undefined) {
        rejectedEvidenceIds.push(source.id);
        errors.push(`source_not_in_engine_provenance_ledger:${source.id}`);
        continue;
      }
      if (registered !== canonicalJson(source)) {
        rejectedEvidenceIds.push(source.id);
        errors.push(`source_ledger_mismatch:${source.id}`);
        continue;
      }
    }
    sourceMap.set(source.id, source);
    acceptedEvidenceIds.push(source.id);
    domains.add(independentDomain(hostOf(source.url)));
  }
  const edgeIds = new Set();
  const acceptedEdges = [];
  let rejectedEdgeCount = 0;
  let validatedClaimCount = 0;
  let contradictionCount = 0;
  for (const edge of edges) {
    if (!edge || typeof edge.id !== 'string' || edge.id.length > 300 || typeof edge.source !== 'string' || edge.source.length > 300 || typeof edge.target !== 'string' || edge.target.length > 300 || typeof edge.status !== 'string' || edge.status.length > 120) {
      errors.push('invalid_edge_shape');
      rejectedEdgeCount++;
      continue;
    }
    if (edgeIds.has(edge.id)) {
      errors.push(`duplicate_edge_id:${edge.id}`);
      rejectedEdgeCount++;
      continue;
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push(`edge_endpoint_missing:${edge.id}`);
      rejectedEdgeCount++;
      continue;
    }
    if (!RELATIONS.has(edge.relation)) {
      errors.push(`unknown_relation:${edge.id}`);
      rejectedEdgeCount++;
      continue;
    }
    if (!finiteUnit(edge.score) || !finiteUnit(edge.confidence)) {
      errors.push(`invalid_edge_score:${edge.id}`);
      rejectedEdgeCount++;
      continue;
    }
    if (!Array.isArray(edge.evidence_ids) || edge.evidence_ids.length === 0 || edge.evidence_ids.length > 50 || edge.evidence_ids.some(id => typeof id !== 'string' || id.length > 200 || !sourceMap.has(id))) {
      errors.push(`edge_without_valid_evidence:${edge.id}`);
      rejectedEdgeCount++;
      continue;
    }
    const highestSourceBound = Math.max(...edge.evidence_ids.map(id => sourceMap.get(id).quality_score));
    if (edge.confidence > highestSourceBound + 0.001) {
      errors.push(`edge_confidence_exceeds_evidence:${edge.id}`);
      rejectedEdgeCount++;
      continue;
    }
    acceptedEdges.push(edge);
    if (edge.confidence < 0.45) warnings.push(`low_confidence_edge:${edge.id}`);
    if (edge.relation === 'supports_hypothesis' || edge.relation === 'contradicts_hypothesis' || edge.relation === 'candidate_causal_link') validatedClaimCount++;
  }
  const pairGroups = new Map();
  for (const edge of acceptedEdges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue;
    const key = `${edge.source}|${edge.target}`;
    pairGroups.set(key, [...(pairGroups.get(key) ?? []), edge]);
  }
  for (const [key, pair] of pairGroups) {
    const support = pair.some(edge => edge.relation === 'supports_hypothesis' || edge.relation === 'candidate_causal_link');
    const contradict = pair.some(edge => edge.relation === 'contradicts_hypothesis');
    if (support && contradict) {
      contradictionCount++;
      warnings.push(`contradictory_relationship:${key}`);
    }
  }
  for (const node of nodes) {
    if (node?.type === 'target_fact' && node.verified !== true) warnings.push(`unverified_local_fact:${node.id}`);
  }
  if (sources.length > 0 && sourceMap.size === 0) errors.push('no_valid_sources');
  if (domains.size < 2 && sources.length > 0) warnings.push('single_independent_source_domain');
  const valid = errors.length === 0 && rejectedEdgeCount === 0 && sourceMap.size === sources.length;
  const status = !valid ? 'rejected' : contradictionCount > 0 ? 'conflicted' : sourceMap.size === 0 ? 'insufficient_evidence' : domains.size >= 2 ? 'validated' : 'provisional';
  return {
    valid,
    status,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    accepted_evidence_ids: acceptedEvidenceIds,
    rejected_evidence_ids: rejectedEvidenceIds,
    validated_claim_count: validatedClaimCount,
    rejected_edge_count: rejectedEdgeCount,
    contradiction_count: contradictionCount,
    independent_source_domains: domains.size,
    graph_digest: sha256(canonicalJson({ schema_version: graph.schema_version, nodes, edges, sources: sources.map(source => ({ id: source.id, excerpt_hash: source.excerpt_hash })) }))
  };
};

export const validateEvidenceSource = (source, allowedDomains) => {
  const graph = { schema_version: 'rea-lunz.external-evidence-graph.v1', nodes: [], edges: [], sources: [source] };
  return validateEvidenceGraph(graph, { allowedDomains });
};
