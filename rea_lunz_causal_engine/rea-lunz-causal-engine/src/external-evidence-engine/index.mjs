import { canonicalJson, decodeHtml, DEFAULT_ALLOWED_DOMAINS, hostOf, independentDomain, isAllowedUrl, safeQueryTerms, sha256, stripHtml } from './security.mjs';
import { sourceIdentity, validateEvidenceGraph } from './validation.mjs';
import { generateCodeFidelityReport, renderCodeFidelityMarkdown } from './fidelity-report.mjs';

const LIMITS = Object.freeze({
  query: 500,
  maxSources: 16,
  packages: 25,
  targetFacts: 50,
  excerpt: 1800,
  responseBytes: 1_000_000,
  timeoutMs: 7000,
  cacheTtlMs: 300_000,
  concurrency: 4,
  cacheEntries: 64,
  provenanceEntries: 1200,
  graphSnapshots: 64,
  maximumQueuedRequests: 128
});

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'what', 'where', 'which', 'how', 'why', 'into', 'uses', 'used', 'code', 'file', 'function', 'issue', 'error', 'problem', 'find', 'explain', 'about', 'does', 'can', 'are', 'was', 'has', 'have', 'its', 'not', 'but', 'our', 'you', 'your', 'does', 'not', 'que', 'para', 'com', 'uma', 'um', 'como', 'isso', 'este', 'esta', 'sobre', 'onde', 'qual', 'quais', 'porque', 'pode', 'tem', 'sao', 'ser', 'por']);

const SOURCE_PROFILES = Object.freeze({
  osv_advisory: { reliability: 0.97, cap: 0.97 },
  deps_dev: { reliability: 0.94, cap: 0.95 },
  npm_registry: { reliability: 0.94, cap: 0.95 },
  github_api: { reliability: 0.9, cap: 0.92 },
  official_docs: { reliability: 0.88, cap: 0.9 },
  web_page: { reliability: 0.68, cap: 0.78 },
  search_snippet: { reliability: 0.42, cap: 0.5 }
});

const nowIso = now => now().toISOString();
const clamp = n => Math.min(1, Math.max(0, n));
const words = value => new Set(String(value ?? '').toLowerCase().match(/[\p{L}\p{N}@._+-]{3,}/gu)?.filter(token => !STOP_WORDS.has(token)) ?? []);
const overlapScore = (query, text) => {
  const a = words(query);
  if (a.size === 0) return 0.25;
  const b = words(text);
  const matched = [...a].filter(token => b.has(token)).length;
  return clamp((matched / a.size) * 0.85 + (String(text).toLowerCase().includes(String(query).toLowerCase()) ? 0.15 : 0));
};
const boundedText = value => String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.excerpt);
const structuredText = value => JSON.stringify(value, null, 2).slice(0, LIMITS.excerpt);
const dedupe = values => [...new Set(values)];

const validPackageName = name => typeof name === 'string' && name.trim().length > 0 && name.length <= 214 && !/[\s\\]/.test(name) && !name.includes('://');
const normalizePackage = item => ({ name: String(item.name).trim(), ...(typeof item.version === 'string' && item.version.trim() ? { version: item.version.trim().replace(/^v/, '') } : {}) });

const readResponseLimited = async (response, maxBytes) => {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('response_size_limit');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('response_size_limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const decodeSearchHref = value => {
  const raw = decodeHtml(value).trim();
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://html.duckduckgo.com');
    const redirected = url.searchParams.get('uddg');
    const destination = redirected ? decodeURIComponent(redirected) : url.href;
    const parsed = new URL(destination);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
};

const parseSearchResults = html => {
  const results = [];
  const marker = /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = marker.exec(html)) !== null && results.length < 24) {
    const url = decodeSearchHref(match[1]);
    if (!url) continue;
    const sectionStart = Math.max(0, html.lastIndexOf('result', match.index - 1));
    const sectionEnd = (() => {
      const next = html.indexOf('result__a', marker.lastIndex);
      return next < 0 ? Math.min(html.length, marker.lastIndex + 3500) : Math.min(html.length, next);
    })();
    const section = html.slice(sectionStart, sectionEnd);
    const snippetMatch = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\//i.exec(section);
    results.push({ url, title: stripHtml(match[2]).slice(0, 240), snippet: stripHtml(snippetMatch?.[1] ?? '').slice(0, 800) });
  }
  return results.filter((item, index, all) => all.findIndex(other => other.url === item.url) === index);
};

const extractPageText = html => stripHtml(String(html ?? '')
  .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
  .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
  .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
  .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' '));

const packageApiUrl = name => `https://registry.npmjs.org/${encodeURIComponent(name)}`;
const depsDevUrl = (name, version) => `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(name)}${version ? `/versions/${encodeURIComponent(version)}` : ''}`;

const summarizeNpm = (payload, item) => {
  const latest = payload?.['dist-tags']?.latest ?? null;
  const selected = item.version ? payload?.versions?.[item.version] : payload?.versions?.[latest];
  return {
    package_name: String(payload?.name ?? item.name),
    requested_version: item.version ?? null,
    latest_version: typeof latest === 'string' ? latest : null,
    description: typeof selected?.description === 'string' ? selected.description.slice(0, 400) : typeof payload?.description === 'string' ? payload.description.slice(0, 400) : null,
    repository: selected?.repository?.url ?? payload?.repository?.url ?? null,
    homepage: selected?.homepage ?? payload?.homepage ?? null,
    dependencies: Object.keys(selected?.dependencies ?? {}).slice(0, 80),
    peer_dependencies: Object.keys(selected?.peerDependencies ?? {}).slice(0, 80),
    requested_version_exists: item.version ? Boolean(payload?.versions?.[item.version]) : null,
    exact_match: String(payload?.name ?? '').toLowerCase() === item.name.toLowerCase()
  };
};

const summarizeDepsDev = (payload, item) => {
  const responsePackage = payload?.package?.name ?? null;
  const responseVersion = payload?.version?.version ?? payload?.version?.versionKey?.version ?? (typeof payload?.version === 'string' ? payload.version : null);
  return {
    package_name: item.name,
    requested_version: item.version ?? null,
    package: payload?.package ?? null,
    version: payload?.version ?? null,
    version_count: Array.isArray(payload?.versions) ? payload.versions.length : null,
    links: payload?.links ?? null,
    dependency_count: Array.isArray(payload?.dependencies) ? payload.dependencies.length : null,
    direct_dependencies: Array.isArray(payload?.dependencies) ? payload.dependencies.slice(0, 80).map(value => ({ package: value.package, version: value.version })) : [],
    exact_match: typeof responsePackage === 'string' && responsePackage.toLowerCase() === item.name.toLowerCase() && (!item.version || responseVersion === item.version)
  };
};

const summarizeOsv = (payload, item) => {
  const vulns = Array.isArray(payload?.vulns) ? payload.vulns : [];
  return vulns.slice(0, 30).map(vuln => {
    const affected = (vuln.affected ?? []).map(entry => ({
      package: entry.package?.name ?? null,
      ecosystem: entry.package?.ecosystem ?? null,
      ranges: (entry.ranges ?? []).slice(0, 10).map(range => ({ type: range.type, events: (range.events ?? []).slice(0, 20) })),
      versions: (entry.versions ?? []).slice(0, 30)
    }));
    const exactMatch = (vuln.affected ?? []).some(entry => String(entry?.package?.name ?? '').toLowerCase() === item.name.toLowerCase() && String(entry?.package?.ecosystem ?? '').toLowerCase() === 'npm');
    return {
      id: String(vuln.id ?? 'unknown'),
      aliases: Array.isArray(vuln.aliases) ? vuln.aliases.slice(0, 30) : [],
      summary: String(vuln.summary ?? '').slice(0, 700),
      details: String(vuln.details ?? '').slice(0, 1200),
      modified: vuln.modified ?? null,
      published: vuln.published ?? null,
      affected,
      requested_package: item.name,
      requested_version: item.version ?? null,
      exact_match: exactMatch
    };
  });
};

export const createExternalEvidenceEngine = (configuration = {}) => {
  const fetchImpl = configuration.fetchImpl ?? globalThis.fetch;
  const now = configuration.now ?? (() => new Date());
  const timeoutMs = Math.min(configuration.timeoutMs ?? LIMITS.timeoutMs, 15000);
  const maxBytes = Math.min(configuration.maxBytes ?? LIMITS.responseBytes, 2_000_000);
  const cacheTtlMs = Math.max(0, configuration.cacheTtlMs ?? LIMITS.cacheTtlMs);
  const allowedDomains = dedupe([
    ...DEFAULT_ALLOWED_DOMAINS,
    ...(configuration.allowedDomains ?? String(process.env.REA_EXTERNAL_EVIDENCE_ALLOWED_DOMAINS ?? '').split(',')).filter(Boolean).map(value => value.trim().toLowerCase())
  ]);
  const cache = new Map();
  const provenanceLedger = new Map();
  const graphLedger = new Map();
  const requestQueue = [];
  let activeRequests = 0;
  const warningsBase = [];
  const releaseSlotFactory = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = requestQueue.shift();
      if (next) next.grant();
      else activeRequests = Math.max(0, activeRequests - 1);
    };
  };
  const acquireSlot = signal => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('request_aborted')); return; }
    if (activeRequests < LIMITS.concurrency) {
      activeRequests++;
      resolve(releaseSlotFactory());
      return;
    }
    if (requestQueue.length >= LIMITS.maximumQueuedRequests) { reject(new Error('request_queue_limit_exceeded')); return; }
    const waiter = { grant: null, reject: null, cleanup: null };
    const abort = () => {
      const index = requestQueue.indexOf(waiter);
      if (index >= 0) requestQueue.splice(index, 1);
      waiter.cleanup?.();
      reject(signal?.reason ?? new Error('request_aborted'));
    };
    waiter.cleanup = () => signal?.removeEventListener('abort', abort);
    waiter.grant = () => { waiter.cleanup?.(); resolve(releaseSlotFactory()); };
    waiter.reject = reject;
    requestQueue.push(waiter);
    signal?.addEventListener('abort', abort, { once: true });
  });
  const remember = (ledger, key, value, maximum) => {
    ledger.delete(key);
    ledger.set(key, value);
    while (ledger.size > maximum) ledger.delete(ledger.keys().next().value);
  };

  const fetchText = async (url, request = {}) => {
    if (!isAllowedUrl(url, allowedDomains)) throw new Error('url_not_allowlisted_https');
    const method = String(request.method ?? 'GET').toUpperCase();
    const key = sha256(`${method}\n${url}\n${method === 'GET' ? '' : canonicalJson(request.body ?? null)}`);
    const cached = cache.get(key);
    if (method === 'GET' && cached && cached.expiresAt > now().getTime()) return { ...cached.value, cached: true };
    if (cached) cache.delete(key);
    const releaseSlot = await acquireSlot(request.signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);
    const abort = () => controller.abort(request.signal?.reason ?? new Error('request_aborted'));
    if (request.signal) {
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    }
    try {
      const response = await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: request.accept ?? 'text/html,application/json;q=0.9,text/plain;q=0.8',
          'user-agent': 'REA-Lunz-External-Evidence-Engine/1.0'
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body), headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'REA-Lunz-External-Evidence-Engine/1.0' } })
      });
      if (response.status >= 300 && response.status < 400) throw new Error('redirect_rejected');
      if (!response.ok) throw new Error(`http_${response.status}`);
      const length = Number(response.headers?.get?.('content-length') ?? 0);
      if (length > maxBytes) throw new Error('response_size_limit');
      const text = await readResponseLimited(response, maxBytes);
      const value = { text, status: response.status, url };
      if (method === 'GET' && cacheTtlMs > 0) {
        cache.set(key, { value, expiresAt: now().getTime() + cacheTtlMs });
        while (cache.size > LIMITS.cacheEntries) cache.delete(cache.keys().next().value);
      }
      return { ...value, cached: false };
    } finally {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener('abort', abort);
      releaseSlot();
    }
  };

  const safeAttempt = async (label, action, warnings) => {
    try {
      return await action();
    } catch (error) {
      warnings.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const makeSource = ({ url, title, excerpt, sourceType, query, entity = null, retrievedAt = nowIso(now), publishedAt = null, baseMatch = null }) => {
    const safeExcerpt = boundedText(excerpt);
    const profile = SOURCE_PROFILES[sourceType] ?? SOURCE_PROFILES.web_page;
    const matchScore = clamp(baseMatch ?? overlapScore(query, `${title} ${safeExcerpt} ${url}`));
    const ageDays = publishedAt && Number.isFinite(Date.parse(publishedAt)) ? Math.max(0, (now().getTime() - Date.parse(publishedAt)) / 86400000) : null;
    const freshnessScore = ageDays === null ? 0.9 : Math.max(0.55, Math.exp(-ageDays / 730));
    const reliability = profile.reliability;
    const qualityScore = Math.round(clamp(reliability * matchScore * Math.max(0.55, freshnessScore)) * 10000) / 10000;
    const source = {
      id: '',
      url,
      domain: hostOf(url),
      title: String(title ?? url).slice(0, 240),
      source_type: sourceType,
      query: String(query ?? '').slice(0, 300),
      retrieved_at: retrievedAt,
      published_at: publishedAt,
      excerpt: safeExcerpt,
      excerpt_hash: sha256(safeExcerpt),
      entity,
      reliability,
      match_score: Math.round(matchScore * 10000) / 10000,
      freshness_score: Math.round(freshnessScore * 10000) / 10000,
      quality_score: qualityScore,
      trust_cap: profile.cap
    };
    source.id = sourceIdentity(source);
    return source;
  };

  const fetchJsonSource = async ({ url, method = 'GET', body, sourceType, query, title, entity, summarize, publishedAt, baseMatch, signal, warnings }) => {
    const fetched = await safeAttempt(`${sourceType}:${url}`, () => fetchText(url, { method, body, signal, accept: 'application/json' }), warnings);
    if (!fetched) return [];
    let payload;
    try {
      payload = JSON.parse(fetched.text);
    } catch {
      warnings.push(`${sourceType}:invalid_json:${url}`);
      return [];
    }
    const summaries = summarize ? summarize(payload) : [payload];
    const list = Array.isArray(summaries) ? summaries : [summaries];
    return list.filter(value => value !== null && value !== undefined).flatMap(value => {
      const summary = value && typeof value === 'object' ? value : { value };
      if (['npm_registry', 'deps_dev', 'osv_advisory'].includes(sourceType) && summary.exact_match !== true) {
        warnings.push(`${sourceType}:exact_entity_match_failed:${url}`);
        return [];
      }
      const sourceTitle = title(summary, payload);
      const sourceEntity = {
        ...(entity ?? {}),
        ...(summary.id ? { advisory_id: summary.id } : {}),
        ...(summary.package_name ? { package_name: summary.package_name } : {}),
        ...(summary.requested_version !== undefined ? { requested_version: summary.requested_version } : {}),
        ...(typeof summary.exact_match === 'boolean' ? { exact_match: summary.exact_match } : {}),
        ...(typeof summary.requested_version_exists === 'boolean' ? { version_exists: summary.requested_version_exists } : {}),
        ...(summary.published ? { published_at: summary.published } : {})
      };
      return [makeSource({ url, title: sourceTitle, excerpt: structuredText(summary), sourceType, query, entity: sourceEntity, publishedAt: summary.published ?? publishedAt ?? null, baseMatch: typeof baseMatch === 'function' ? baseMatch(summary) : baseMatch })];
    });
  };

  const discoverWeb = async (query, maxSources, signal, warnings) => {
    const safeTerms = safeQueryTerms(query);
    if (!safeTerms) return [];
    const searchUrl = new URL('https://html.duckduckgo.com/html/');
    searchUrl.searchParams.set('q', safeTerms);
    const fetched = await safeAttempt('web_search', () => fetchText(searchUrl.href, { signal }), warnings);
    if (!fetched) return [];
    const candidates = parseSearchResults(fetched.text).filter(item => isAllowedUrl(item.url, allowedDomains));
    const snippetSources = candidates.filter(item => item.snippet).map(item => makeSource({ url: item.url, title: item.title, excerpt: item.snippet, sourceType: 'search_snippet', query, baseMatch: overlapScore(query, `${item.title} ${item.snippet}`) })).filter(source => source.match_score >= 0.18).slice(0, maxSources);
    const pageSources = [];
    const selected = candidates.slice(0, Math.min(maxSources, LIMITS.concurrency * 2));
    const fetchedPages = await Promise.all(selected.map(async item => {
      const page = await safeAttempt(`web_page:${hostOf(item.url)}`, () => fetchText(item.url, { signal, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' }), warnings);
      if (!page) return null;
      const excerpt = extractPageText(page.text).slice(0, LIMITS.excerpt);
      if (excerpt.length < 40) return null;
      const source = makeSource({ url: item.url, title: item.title || item.url, excerpt, sourceType: /docs\.|developer\.mozilla|nodejs\.org|typescriptlang|learn\.microsoft/i.test(item.url) ? 'official_docs' : 'web_page', query, baseMatch: overlapScore(query, `${item.title} ${item.snippet} ${excerpt}`) });
      return source.match_score >= 0.3 ? source : null;
    }));
    pageSources.push(...fetchedPages.filter(Boolean));
    return [...pageSources, ...snippetSources].sort((a, b) => b.quality_score - a.quality_score).slice(0, maxSources * 2);
  };

  const researchPackage = async (item, query, signal, warnings) => {
    if (!validPackageName(item.name)) {
      warnings.push(`invalid_package_name:${String(item.name).slice(0, 100)}`);
      return [];
    }
    const normalized = normalizePackage(item);
    const [npmSources, dependencySources, osvSources] = await Promise.all([
      fetchJsonSource({
        url: packageApiUrl(normalized.name), sourceType: 'npm_registry', query, signal, warnings,
        entity: { package_name: normalized.name, requested_version: normalized.version ?? null, exact_match: true },
        summarize: payload => [summarizeNpm(payload, normalized)],
        title: summary => `npm registry: ${normalized.name}${normalized.version ? `@${normalized.version}` : ''}`,
        baseMatch: 0.98
      }),
      fetchJsonSource({
        url: depsDevUrl(normalized.name, normalized.version), sourceType: 'deps_dev', query, signal, warnings,
        entity: { package_name: normalized.name, requested_version: normalized.version ?? null, exact_match: true },
        summarize: payload => [summarizeDepsDev(payload, normalized)],
        title: () => `deps.dev: ${normalized.name}${normalized.version ? `@${normalized.version}` : ''}`,
        baseMatch: 0.98
      }),
      fetchJsonSource({
        url: 'https://api.osv.dev/v1/query', method: 'POST', body: { package: { name: normalized.name, ecosystem: 'npm' }, ...(normalized.version ? { version: normalized.version } : {}) }, sourceType: 'osv_advisory', query, signal, warnings,
        entity: { package_name: normalized.name, requested_version: normalized.version ?? null, exact_match: true },
        summarize: payload => summarizeOsv(payload, normalized),
        title: summary => `OSV advisory: ${summary.id ?? normalized.name}`,
        baseMatch: 0.99
      })
    ]);
    const enrichedNpm = npmSources.map(source => ({ ...source, url: source.url, source_type: 'npm_registry' }));
    return [...osvSources, ...dependencySources, ...enrichedNpm];
  };

  const research = async (input, runtime = {}) => {
    const query = String(input?.query ?? '').trim().slice(0, LIMITS.query);
    if (query.length < 3) throw new TypeError('query_must_contain_at_least_3_characters');
    const packages = (Array.isArray(input.packages) ? input.packages : []).slice(0, LIMITS.packages).filter(item => item && typeof item.name === 'string').map(normalizePackage);
    const targetFactsInput = (Array.isArray(input.targetFacts) ? input.targetFacts : []).slice(0, LIMITS.targetFacts);
    const maxSources = Math.max(1, Math.min(LIMITS.maxSources, Number.isInteger(input.maxSources) ? input.maxSources : 10));
    const warnings = [...warningsBase];
    const [webSources, packageSourceGroups] = await Promise.all([
      discoverWeb(query, maxSources, runtime.signal, warnings),
      Promise.all(packages.map(item => researchPackage(item, query, runtime.signal, warnings)))
    ]);
    const rawSources = [...webSources, ...packageSourceGroups.flat()];
    const seen = new Set();
    const sources = rawSources.filter(source => {
      if (seen.has(source.id)) return false;
      seen.add(source.id);
      return true;
    }).filter(source => ['npm_registry', 'deps_dev', 'osv_advisory'].includes(source.source_type) || source.match_score >= 0.3).sort((a, b) => b.quality_score - a.quality_score).slice(0, maxSources);
    for (const source of sources) remember(provenanceLedger, source.id, canonicalJson(source), LIMITS.provenanceEntries);
    const localFacts = [];
    for (const fact of targetFactsInput) {
      if (!fact || typeof fact.id !== 'string' || typeof fact.value !== 'string' || fact.value.trim().length === 0) continue;
      let verified = false;
      let verifiedEvidenceId = null;
      if (fact.evidence_id && typeof configuration.resolveLocalEvidence === 'function') {
        const result = await safeAttempt(`local_evidence:${fact.evidence_id}`, () => configuration.resolveLocalEvidence(fact.evidence_id), warnings);
        if (result) {
          const payload = JSON.stringify(result.normalized_result ?? result);
          if (payload.toLocaleLowerCase().includes(fact.value.toLocaleLowerCase())) {
            verified = true;
            verifiedEvidenceId = fact.evidence_id;
          }
        }
      }
      localFacts.push({ id: fact.id, kind: String(fact.kind ?? 'unknown'), value: fact.value.slice(0, 512), evidence_id: verifiedEvidenceId, verified });
    }
    const graph = buildGraph({ query, packages, localFacts, sources, generatedAt: nowIso(now) });
    const canonicalGraph = canonicalJson(graph);
    remember(graphLedger, sha256(canonicalGraph), canonicalGraph, LIMITS.graphSnapshots);
    const validation = validateEvidenceGraph(graph, { allowedDomains });
    const qualityReport = buildQualityReport(sources, validation, warnings);
    const status = validation.status === 'rejected' ? 'rejected' : sources.length === 0 ? 'insufficient_evidence' : validation.status === 'validated' ? 'validated' : validation.status;
    return {
      schema_version: 'rea-lunz.external-evidence-result.v1',
      status,
      query,
      graph,
      validation,
      quality_report: qualityReport,
      source_count: sources.length,
      accepted_source_count: validation.accepted_evidence_ids.length,
      warnings: dedupe(warnings).slice(0, 80),
      cache: { entries: cache.size, ttl_ms: cacheTtlMs }
    };
  };

  const validate = graph => {
    const validation = validateEvidenceGraph(graph, { allowedDomains, knownSources: provenanceLedger, requireRegisteredSources: true });
    let canonicalGraph;
    try {
      canonicalGraph = canonicalJson(graph);
    } catch {
      canonicalGraph = '';
    }
    if (!canonicalGraph || !graphLedger.has(sha256(canonicalGraph))) {
      return {
        ...validation,
        valid: false,
        status: 'rejected',
        errors: [...new Set([...validation.errors, 'graph_not_in_engine_provenance_ledger'])]
      };
    }
    return validation;
  };
  return Object.freeze({ research, validate, allowedDomains: [...allowedDomains], cacheSize: () => cache.size, clearCache: () => cache.clear(), provenanceSourceCount: () => provenanceLedger.size, provenanceGraphCount: () => graphLedger.size });
};

const stableId = (prefix, value) => `${prefix}_${sha256(String(value)).slice(0, 20)}`;

const aggregate = values => {
  const byDomain = new Map();
  for (const item of values) {
    const domain = independentDomain(hostOf(item.source.url));
    byDomain.set(domain, Math.max(byDomain.get(domain) ?? 0, item.score));
  }
  return clamp(1 - [...byDomain.values()].reduce((rest, score) => rest * (1 - score), 1));
};

const buildGraph = ({ query, packages, localFacts, sources, generatedAt }) => {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  const addNode = node => {
    if (!nodeIds.has(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }
  };
  const addEdge = edge => {
    if (edgeIds.has(edge.id)) return;
    edgeIds.add(edge.id);
    edges.push(edge);
  };
  const investigationId = stableId('inv', query.toLowerCase());
  addNode({ id: investigationId, type: 'investigation', label: query, verified: true, properties: { generated_at: generatedAt }, source_evidence_ids: [] });
  const packageNodes = new Map();
  for (const item of packages) {
    const id = stableId('pkg', `${item.name}@${item.version ?? '*'}`);
    packageNodes.set(`${item.name.toLowerCase()}@${item.version ?? '*'}`, id);
    addNode({ id, type: 'package', label: `${item.name}${item.version ? `@${item.version}` : ''}`, verified: false, properties: { package_name: item.name, version: item.version ?? null, requested_by_investigation: true, externally_verified: false }, source_evidence_ids: [] });
  }
  for (const fact of localFacts) {
    addNode({ id: stableId('fact', fact.id), type: 'target_fact', label: fact.value, verified: fact.verified, properties: { kind: fact.kind, value: fact.value, evidence_id: fact.evidence_id }, source_evidence_ids: fact.evidence_id ? [fact.evidence_id] : [] });
  }
  const scored = [];
  for (const source of sources) {
    addNode({ id: source.id, type: source.source_type === 'osv_advisory' ? 'advisory_evidence' : 'external_evidence', label: source.title, verified: true, properties: { url: source.url, domain: source.domain, source_type: source.source_type, quality_score: source.quality_score, match_score: source.match_score }, source_evidence_ids: [source.id] });
    const isContradictory = /\b(?:not affected|unaffected|not vulnerable|no vulnerability|false positive|not impacted)\b/i.test(`${source.title} ${source.excerpt}`) || /requested_version_exists\s*[\"']?\s*:\s*false/i.test(source.excerpt);
    addEdge({ id: stableId('edge', `${source.id}|${investigationId}|${isContradictory ? 'contradicts_hypothesis' : 'evidence_for'}`), source: source.id, target: investigationId, relation: isContradictory ? 'contradicts_hypothesis' : 'evidence_for', score: source.match_score, confidence: source.quality_score, evidence_ids: [source.id], status: isContradictory ? 'explicit_negative_statement_requires_review' : 'relevant_source_not_conclusive' });
    scored.push({ source, score: source.quality_score });
    const name = source.entity?.package_name;
    const version = source.entity?.requested_version ?? null;
    if (name) {
      const key = `${String(name).toLowerCase()}@${version ?? '*'}`;
      const packageId = packageNodes.get(key) ?? stableId('pkg', key);
      if (!packageNodes.has(key)) addNode({ id: packageId, type: 'package', label: `${name}${version ? `@${version}` : ''}`, verified: true, properties: { package_name: name, version }, source_evidence_ids: [] });
      packageNodes.set(key, packageId);
      const parentNode = nodes.find(node => node.id === packageId);
      if (parentNode && source.entity?.exact_match === true) {
        parentNode.verified = true;
        parentNode.properties.externally_verified = true;
        if (typeof source.entity.version_exists === 'boolean') parentNode.properties.version_exists = source.entity.version_exists;
        parentNode.source_evidence_ids = dedupe([...parentNode.source_evidence_ids, source.id]);
      }
      if (source.source_type === 'osv_advisory') {
        const aliases = Array.isArray(source.entity?.advisory_id) ? source.entity.advisory_id : source.entity?.advisory_id ? [source.entity.advisory_id] : [];
        const advisoryLabel = source.title.replace(/^OSV advisory:\s*/i, '');
        const advisoryId = stableId('advisory', `${name}|${version ?? '*'}|${advisoryLabel}`);
        addNode({ id: advisoryId, type: 'vulnerability_candidate', label: advisoryLabel, verified: true, properties: { aliases, package_name: name, version, origin: 'OSV.dev' }, source_evidence_ids: [source.id] });
        addEdge({ id: stableId('edge', `${advisoryId}|${packageId}|affects_package_version`), source: advisoryId, target: packageId, relation: 'affects_package_version', score: source.match_score, confidence: Math.min(source.quality_score, source.trust_cap), evidence_ids: [source.id], status: version ? 'service_matched_version_query' : 'package_level_candidate' });
      } else if (['npm_registry', 'deps_dev'].includes(source.source_type)) {
        addEdge({ id: stableId('edge', `${source.id}|${packageId}|evidence_for`), source: source.id, target: packageId, relation: 'evidence_for', score: source.match_score, confidence: source.quality_score, evidence_ids: [source.id], status: 'exact_package_metadata' });
        let metadata;
        try { metadata = JSON.parse(source.excerpt); } catch { metadata = {}; }
        const dependencyEntries = source.source_type === 'npm_registry'
          ? [
              ...(Array.isArray(metadata.dependencies) ? metadata.dependencies.map(dependencyName => ({ package: dependencyName, version: null, kind: 'direct' })) : []),
              ...(Array.isArray(metadata.peer_dependencies) ? metadata.peer_dependencies.map(dependencyName => ({ package: dependencyName, version: null, kind: 'peer' })) : [])
            ]
          : (Array.isArray(metadata.direct_dependencies) ? metadata.direct_dependencies.map(item => ({ package: item.package, version: item.version, kind: 'direct' })) : []);
        for (const dependency of dependencyEntries.slice(0, 80)) {
          const dependencyName = typeof dependency.package === 'string' ? dependency.package : dependency.package?.name;
          const dependencyVersion = typeof dependency.version === 'string' ? dependency.version : dependency.version?.version ?? null;
          if (typeof dependencyName !== 'string' || dependencyName.trim().length === 0) continue;
          const dependencyKey = `${dependencyName.toLowerCase()}@${dependencyVersion ?? '*'}`;
          const dependencyId = packageNodes.get(dependencyKey) ?? stableId('pkg', dependencyKey);
          if (!packageNodes.has(dependencyKey)) addNode({ id: dependencyId, type: 'package', label: `${dependencyName}${dependencyVersion ? `@${dependencyVersion}` : ''}`, verified: true, properties: { package_name: dependencyName, version: dependencyVersion, discovered_from_metadata: true }, source_evidence_ids: [source.id] });
          else {
            const dependencyNode = nodes.find(node => node.id === dependencyId);
            if (dependencyNode) {
              dependencyNode.verified = true;
              dependencyNode.properties.discovered_from_metadata = true;
              dependencyNode.source_evidence_ids = dedupe([...dependencyNode.source_evidence_ids, source.id]);
            }
          }
          packageNodes.set(dependencyKey, dependencyId);
          addEdge({ id: stableId('edge', `${packageId}|${dependencyId}|declares_dependency|${dependency.kind}`), source: packageId, target: dependencyId, relation: 'declares_dependency', score: source.match_score, confidence: source.quality_score, evidence_ids: [source.id], status: dependency.kind === 'peer' ? 'observed_peer_dependency' : 'observed_dependency_metadata' });
        }
      }
    }
    const body = `${source.title} ${source.excerpt} ${source.url}`.toLocaleLowerCase();
    for (const fact of localFacts.filter(value => value.verified)) {
      const value = fact.value.toLocaleLowerCase();
      if (value.length < 3 || !body.includes(value)) continue;
      const factId = stableId('fact', fact.id);
      addEdge({ id: stableId('edge', `${source.id}|${factId}|mentions_entity`), source: source.id, target: factId, relation: 'mentions_entity', score: 0.98, confidence: Math.min(source.quality_score, 0.75), evidence_ids: [source.id], status: 'exact_text_match' });
      if (source.source_type === 'osv_advisory' && fact.kind === 'package') {
        addEdge({ id: stableId('edge', `${source.id}|${factId}|candidate_causal_link`), source: source.id, target: factId, relation: 'candidate_causal_link', score: source.match_score, confidence: Math.min(0.68, source.quality_score), evidence_ids: [source.id], status: 'hypothesis_requires_code_path_confirmation' });
      }
    }
    if (/\b(?:caused by|causes|due to|triggered by|results? from|introduced in|regression|exploited by)\b/i.test(`${source.title} ${source.excerpt}`) && source.quality_score >= 0.55) {
      addEdge({ id: stableId('edge', `${source.id}|${investigationId}|candidate_causal_link`), source: source.id, target: investigationId, relation: 'candidate_causal_link', score: source.match_score, confidence: Math.min(0.65, source.quality_score), evidence_ids: [source.id], status: 'candidate_not_proven_causality' });
    }
  }
  const sourcesByEntity = new Map();
  for (const source of sources) {
    const key = source.entity?.package_name ? `${String(source.entity.package_name).toLowerCase()}@${source.entity?.requested_version ?? '*'}` : null;
    if (key) sourcesByEntity.set(key, [...(sourcesByEntity.get(key) ?? []), source]);
  }
  for (const [key, group] of sourcesByEntity) {
    const unique = group.filter((source, index, all) => all.findIndex(other => independentDomain(other.domain) === independentDomain(source.domain)) === index);
    if (unique.length > 1) {
      const id = packageNodes.get(key) ?? stableId('pkg', key);
      const combined = aggregate(unique.map(source => ({ source, score: source.quality_score })));
      for (let index = 1; index < unique.length; index++) {
        const left = unique[0];
        const right = unique[index];
        addEdge({ id: stableId('edge', `${left.id}|${right.id}|corroborates`), source: left.id, target: right.id, relation: 'corroborates', score: combined, confidence: Math.min(combined, Math.max(left.quality_score, right.quality_score)), evidence_ids: [left.id, right.id], status: 'independent_domains' });
      }
      void id;
    }
  }
  return {
    schema_version: 'rea-lunz.external-evidence-graph.v1',
    generated_at: generatedAt,
    query,
    root_node_id: investigationId,
    nodes,
    edges,
    sources,
    scoring: {
      method: 'domain-capped noisy-OR with source reliability, query match, freshness, and evidence-bound edge confidence',
      aggregated_evidence_score: Number(aggregate(scored.map(value => ({ source: value.source, score: value.score })).filter(value => value.score > 0)).toFixed(4)),
      score_semantics: 'Evidence retrieval and source quality ranking only; not a calibrated hypothesis probability.',
      causal_edge_semantics: 'Candidate relations are hypotheses unless supported by exact artifact observations and independently validated evidence.'
    }
  };
};

const buildQualityReport = (sources, validation, warnings) => {
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const sorted = [...sources].sort((a, b) => b.quality_score - a.quality_score);
  return {
    schema_version: 'rea-lunz.external-evidence-quality.v1',
    status: validation.status,
    source_count: sources.length,
    accepted_source_count: validation.accepted_evidence_ids.length,
    independent_source_domains: validation.independent_source_domains,
    mean_reliability: Number(mean(sources.map(source => source.reliability)).toFixed(4)),
    mean_match_score: Number(mean(sources.map(source => source.match_score)).toFixed(4)),
    mean_quality_score: Number(mean(sources.map(source => source.quality_score)).toFixed(4)),
    contradiction_count: validation.contradiction_count,
    graph_validation_errors: validation.errors,
    graph_validation_warnings: validation.warnings,
    retrieval_warnings: dedupe(warnings).slice(0, 80),
    high_quality_sources: sorted.filter(source => source.quality_score >= 0.7).map(source => ({ id: source.id, title: source.title, url: source.url, quality_score: source.quality_score })),
    excluded_low_quality_sources: sorted.filter(source => source.quality_score < 0.45).map(source => ({ id: source.id, title: source.title, url: source.url, quality_score: source.quality_score })),
    confidence_interpretation: validation.status === 'validated' ? 'Source provenance validated across independent domains; individual claims still require direct support and remain bounded by the supplied evidence.' : validation.status === 'provisional' ? 'Evidence is traceable but lacks independent-domain corroboration.' : validation.status === 'conflicted' ? 'Contradictory evidence exists; causal conclusions should remain unresolved.' : 'Insufficient validated evidence for a firm conclusion.'
  };
};

export { validateEvidenceGraph, generateCodeFidelityReport, renderCodeFidelityMarkdown, isAllowedUrl, DEFAULT_ALLOWED_DOMAINS, safeQueryTerms, sha256 };
