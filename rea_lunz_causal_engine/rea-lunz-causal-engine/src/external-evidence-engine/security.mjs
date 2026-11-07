import { createHash } from 'node:crypto';

export const DEFAULT_ALLOWED_DOMAINS = Object.freeze([
  'html.duckduckgo.com',
  'duckduckgo.com',
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'docs.github.com',
  'api.deps.dev',
  'api.osv.dev',
  'registry.npmjs.org',
  'www.npmjs.com',
  'developer.mozilla.org',
  'nodejs.org',
  'typescriptlang.org',
  'docs.python.org',
  'electronjs.org',
  'chromium.org',
  'learn.microsoft.com',
  'owasp.org',
  'cwe.mitre.org',
  'nvd.nist.gov'
]);

export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

export const canonicalJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

export const normalizeHost = host => String(host ?? '').toLowerCase().replace(/\.$/, '');

export const isAllowedUrl = (value, allowedDomains = DEFAULT_ALLOWED_DOMAINS) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = normalizeHost(url.hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') || !host.includes('.')) return false;
  return allowedDomains.some(domain => {
    const normalized = normalizeHost(domain.trim());
    return normalized && (host === normalized || host.endsWith(`.${normalized}`));
  });
};

export const decodeHtml = value => String(value ?? '')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));

export const stripHtml = value => decodeHtml(String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<!--([\s\S]*?)-->/g, ' ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim();

export const safeQueryTerms = value => {
  const normalized = String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?:https?:\/\/)?\S+\.(?:js|ts|tsx|jsx|py|rs|go|c|h|cpp|java|cs)\b[^\s]*/gi, ' ')
    .replace(/`(?:\\.|[^`])*`/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/[^\p{L}\p{N}@./_:+-]+/gu, ' ')
    .split(/\s+/)
    .filter(term => term.length > 2 && !/^0x[\da-f]+$/i.test(term));
  return [...new Set(normalized)].slice(0, 16).join(' ').slice(0, 280);
};

export const hostOf = value => {
  try {
    return normalizeHost(new URL(value).hostname);
  } catch {
    return '';
  }
};

export const independentDomain = host => {
  const value = normalizeHost(host);
  const multiLabelSuffixes = new Set(['co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'com.cn', 'co.nz', 'com.sg', 'com.mx', 'co.in']);
  const parts = value.split('.');
  if (parts.length < 2) return value;
  const suffix = parts.slice(-2).join('.');
  return multiLabelSuffixes.has(suffix) && parts.length >= 3 ? parts.slice(-3).join('.') : suffix;
};
