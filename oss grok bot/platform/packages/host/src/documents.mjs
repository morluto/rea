import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fail } from './store.mjs';
const require = createRequire(import.meta.url);
const { version: PDFJS_VERSION } = require('pdfjs-dist/package.json');
const { version: FFLATE_VERSION } = require('fflate/package.json');
// fast-xml-parser does not export ./package.json; resolve its version from the installed package directory.
const { version: FXP_VERSION } = JSON.parse(
  readFileSync(join(dirname(require.resolve('fast-xml-parser')), '..', 'package.json'), 'utf8'),
);

export const DOCUMENT_MEDIA = {
  'application/pdf': { kind: 'pdf', extractor: `pdfjs-dist ${PDFJS_VERSION}` },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'docx',
    extractor: `fflate ${FFLATE_VERSION} + fast-xml-parser ${FXP_VERSION}`,
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'xlsx',
    extractor: `fflate ${FFLATE_VERSION} + fast-xml-parser ${FXP_VERSION}`,
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: 'pptx',
    extractor: `fflate ${FFLATE_VERSION} + fast-xml-parser ${FXP_VERSION}`,
  },
};

export const DOCUMENT_LIMITS = {
  maxInputBytes: 8 * 1024 * 1024,
  maxTextChars: 200000,
  maxPdfPages: 200,
  maxSheets: 20,
  maxSheetRows: 2000,
  maxSlides: 200,
  // Cumulative cap on decompressed Office bytes accepted during streaming unzip.
  // The counter bounds logical output bytes, not total process memory: accepted
  // chunks are retained and the finished file is assembled into one contiguous
  // copy, so transient retention can briefly hold both. The 8 MiB
  // compressed-input bound applies first.
  maxExpandedBytes: 64 * 1024 * 1024,
  // Input granularity for streaming unzip: the archive is fed to fflate in
  // slices this size so inflated output is delivered incrementally and the
  // cumulative check above aborts mid-stream. Slices must stay small because
  // one compressed slice can expand enormously (4 KiB in ~= 4 MiB out on the
  // reference bomb; external acceptance caps output callbacks at 5 MiB).
  unzipSliceBytes: 4096,
  timeoutMs: 30000,
  maxConcurrent: 2,
};

const textDecoder = new TextDecoder('utf-8', { fatal: false });
const check = (signal, stopped) => {
  if (stopped) fail('shutting_down', 'Host is stopping', 503);
  signal?.throwIfAborted();
};

function truncateRecord(base, text, parts, limitations) {
  const limited = text.slice(0, DOCUMENT_LIMITS.maxTextChars);
  const charCapped = limited.length < text.length;
  return {
    ...base,
    state: charCapped ? 'partial' : base.state,
    text: limited,
    truncated: charCapped || base.truncated === true,
    parts,
    limitations: charCapped
      ? [...limitations, 'extracted text truncated at 200,000 characters']
      : limitations,
  };
}

async function extractPdf(bytes, signal, stopped) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const doc = await loading.promise;
  try {
    const pages = Math.min(doc.numPages, DOCUMENT_LIMITS.maxPdfPages);
    const limitations = [];
    if (doc.numPages > pages)
      limitations.push(`only the first ${pages} of ${doc.numPages} pages examined`);
    if (doc.numPages === 0) limitations.push('document has no pages');
    const parts = [];
    let text = '';
    let pagesCapped = false;
    for (let n = 1; n <= pages; n++) {
      check(signal, stopped);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str ?? '').join('');
      parts.push({ label: `page ${n}`, chars: pageText.length });
      text += (text && pageText ? '\n' : '') + pageText;
      if (text.length >= DOCUMENT_LIMITS.maxTextChars) {
        pagesCapped = true;
        break;
      }
    }
    if (!text.trim())
      return {
        state: 'partial',
        text: '',
        truncated: false,
        parts,
        limitations: [
          ...limitations,
          'no embedded text found; this PDF may be scanned images or encrypted',
        ],
      };
    return {
      state: 'ready',
      text,
      truncated: doc.numPages > pages || pagesCapped,
      parts,
      limitations,
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

function decodeXmlEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        try {
          const code =
            entity[0] === '#'
              ? entity[1] === 'x'
                ? parseInt(entity.slice(2), 16)
                : parseInt(entity.slice(1), 10)
              : NaN;
          if (!Number.isFinite(code)) return match;
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
    }
  });
}

function ooxmlStrings(xml) {
  return [
    ...xml.matchAll(
      /<a:t[^>]*>([\s\S]*?)<\/a:t>|<(?:[A-Za-z_][\w.-]*:)?t[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g,
    ),
  ]
    .map((m) => decodeXmlEntities((m[1] ?? m[2] ?? '').replace(/<[^>]+>/g, '')))
    .filter(Boolean);
}

async function unzipOffice(bytes, signal, stopped) {
  const { Unzip, UnzipInflate } = await import('fflate');
  check(signal, stopped);
  const files = {};
  let expanded = 0;
  let largestChunk = 0;
  const stream = new Unzip();
  stream.register(UnzipInflate);
  stream.onfile = (entry) => {
    const chunks = [];
    entry.ondata = (error, chunk, final) => {
      // fflate converts any throw inside this handler into an ondata error
      // delivery, so rethrow our own tagged refusals instead of masking them.
      if (error?.tag) throw error;
      if (error)
        fail('unavailable', 'Office file could not be unzipped; it may be corrupt or encrypted');
      expanded += chunk.length;
      if (chunk.length > largestChunk) largestChunk = chunk.length;
      if (expanded > DOCUMENT_LIMITS.maxExpandedBytes)
        fail(
          'unavailable',
          `Office contents expand beyond the ${DOCUMENT_LIMITS.maxExpandedBytes / 1048576} MiB extraction bound ` +
            `(refused during streaming after accepting ${expanded} output bytes; ` +
            `largest output chunk ${largestChunk} bytes)`,
        );
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(expanded > 0 ? chunks.reduce((n, c) => n + c.length, 0) : 0);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        files[entry.name] = out;
      }
    };
    entry.start();
  };
  // Feed the archive in small input slices so the inflater emits output
  // incrementally and the cumulative check above aborts before the full
  // expansion is materialized. A single push lets fflate inflate everything
  // into one output callback before any check runs.
  const input = new Uint8Array(bytes);
  const slice = DOCUMENT_LIMITS.unzipSliceBytes;
  try {
    if (input.length === 0) {
      stream.push(input, true);
    } else {
      for (let at = 0; at < input.length; at += slice) {
        check(signal, stopped);
        stream.push(
          input.subarray(at, Math.min(at + slice, input.length)),
          at + slice >= input.length,
        );
      }
    }
  } catch (e) {
    if (e?.tag) throw e;
    fail('unavailable', 'Office file could not be unzipped; it may be corrupt or encrypted');
  }
  check(signal, stopped);
  return files;
}

async function extractDocx(bytes, signal, stopped) {
  const files = await unzipOffice(bytes, signal, stopped);
  const raw = files['word/document.xml'];
  if (!raw) fail('unavailable', 'Word package is missing word/document.xml');
  const strings = ooxmlStrings(textDecoder.decode(raw));
  const parts = [{ label: 'document', chars: strings.join('\n').length }];
  if (!strings.length)
    return {
      state: 'partial',
      text: '',
      truncated: false,
      parts,
      limitations: ['no readable paragraphs found in word/document.xml'],
    };
  return { state: 'ready', text: strings.join('\n'), truncated: false, parts, limitations: [] };
}

async function extractXlsx(bytes, signal, stopped) {
  const files = await unzipOffice(bytes, signal, stopped);
  const names = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if (!names.length) fail('unavailable', 'Workbook contains no readable worksheets');
  const kept = names.slice(0, DOCUMENT_LIMITS.maxSheets);
  const limitations =
    names.length > kept.length
      ? [`only the first ${kept.length} of ${names.length} worksheets examined`]
      : [];
  const shared = files['xl/sharedStrings.xml']
    ? ooxmlStrings(textDecoder.decode(files['xl/sharedStrings.xml']))
    : [];
  const parts = [];
  const lines = [];
  let rowsCapped = false;
  for (const name of kept) {
    check(signal, stopped);
    const xml = textDecoder.decode(files[name]);
    const values = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rows = 0;
    for (const row of xml.matchAll(rowRe)) {
      if (++rows > DOCUMENT_LIMITS.maxSheetRows) {
        rowsCapped = true;
        break;
      }
      const cells = [];
      for (const cell of row[1].matchAll(/<c[^>]*?(?:t="s")?[^>]*>([\s\S]*?)<\/c>/g)) {
        const inner = cell[1];
        const sharedRef = inner.match(/<v>(\d+)<\/v>/);
        if (cell[0].includes('t="s"') && sharedRef) cells.push(shared[Number(sharedRef[1])] ?? '');
        else {
          const inline = inner.match(
            /<(?:[A-Za-z_][\w.-]*:)?t[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/,
          );
          cells.push(
            decodeXmlEntities(
              (inline ? inline[1] : (inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '')).replace(
                /<[^>]+>/g,
                '',
              ),
            ),
          );
        }
      }
      if (cells.some(Boolean)) values.push(cells.join('\t'));
    }
    if (rows > DOCUMENT_LIMITS.maxSheetRows)
      limitations.push(`${name}: rows truncated at ${DOCUMENT_LIMITS.maxSheetRows}`);
    parts.push({ label: name.replace('xl/worksheets/', ''), chars: values.join('\n').length });
    if (values.length) lines.push(`[${name.replace('xl/worksheets/', '')}]\n${values.join('\n')}`);
    if (lines.join('\n').length >= DOCUMENT_LIMITS.maxTextChars) {
      rowsCapped = true;
      break;
    }
  }
  const text = lines.join('\n\n');
  if (!text.trim())
    return {
      state: 'partial',
      text: '',
      truncated: false,
      parts,
      limitations: [...limitations, 'no readable cell values found'],
    };
  return {
    state: 'ready',
    text,
    truncated: names.length > kept.length || rowsCapped,
    parts,
    limitations,
  };
}

async function extractPptx(bytes, signal, stopped) {
  const files = await unzipOffice(bytes, signal, stopped);
  const names = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (!names.length) fail('unavailable', 'Presentation contains no readable slides');
  const kept = names.slice(0, DOCUMENT_LIMITS.maxSlides);
  const limitations =
    names.length > kept.length
      ? [`only the first ${kept.length} of ${names.length} slides examined`]
      : [];
  const parts = [];
  const lines = [];
  let slidesCapped = false;
  for (const name of kept) {
    check(signal, stopped);
    const strings = ooxmlStrings(textDecoder.decode(files[name]));
    parts.push({ label: name.replace('ppt/slides/', ''), chars: strings.join('\n').length });
    if (strings.length) lines.push(`[${name.replace('ppt/slides/', '')}]\n${strings.join('\n')}`);
    if (lines.join('\n').length >= DOCUMENT_LIMITS.maxTextChars) {
      slidesCapped = true;
      break;
    }
  }
  const text = lines.join('\n\n');
  if (!text.trim())
    return {
      state: 'partial',
      text: '',
      truncated: false,
      parts,
      limitations: [...limitations, 'no readable text found on slides'],
    };
  return {
    state: 'ready',
    text,
    truncated: names.length > kept.length || slidesCapped,
    parts,
    limitations,
  };
}

const EXTRACTORS = { pdf: extractPdf, docx: extractDocx, xlsx: extractXlsx, pptx: extractPptx };

export class Documents {
  constructor(store, product) {
    this.store = store;
    this.product = product;
    this.cache = new Map();
    this.active = 0;
    this.stopped = false;
  }
  supported(mediaType) {
    return DOCUMENT_MEDIA[mediaType]?.kind ?? null;
  }
  async extract(revision, { signal } = {}) {
    const info = DOCUMENT_MEDIA[revision.mediaType];
    if (!info)
      return {
        revisionId: revision.id,
        digest: revision.digest,
        mediaType: revision.mediaType,
        state: 'unsupported',
        text: '',
        truncated: false,
        parts: [],
        extractor: null,
        extractedAt: Date.now(),
        limitations: [`${revision.mediaType} has no document text extractor`],
      };
    if (revision.size > DOCUMENT_LIMITS.maxInputBytes)
      return {
        revisionId: revision.id,
        digest: revision.digest,
        mediaType: revision.mediaType,
        state: 'unavailable',
        text: '',
        truncated: false,
        parts: [],
        extractor: info.extractor,
        extractedAt: Date.now(),
        limitations: [
          `input exceeds the ${DOCUMENT_LIMITS.maxInputBytes / 1048576} MiB extraction bound`,
        ],
      };
    const key = `${revision.id}:${revision.digest}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.stopped) fail('shutting_down', 'Host is stopping', 503);
    if (this.active >= DOCUMENT_LIMITS.maxConcurrent)
      fail('busy', 'Document extraction is busy; retry shortly', 503);
    if (signal?.aborted) fail('cancelled', 'Extraction cancelled', 409);
    this.active += 1;
    try {
      const bytes = this.product.bytes(revision);
      if (bytes.length > DOCUMENT_LIMITS.maxInputBytes)
        return {
          revisionId: revision.id,
          digest: revision.digest,
          mediaType: revision.mediaType,
          state: 'unavailable',
          text: '',
          truncated: false,
          parts: [],
          extractor: info.extractor,
          extractedAt: Date.now(),
          limitations: [
            `input is ${bytes.length} bytes; extraction is bounded at ${DOCUMENT_LIMITS.maxInputBytes} bytes`,
          ],
        };
      const base = {
        revisionId: revision.id,
        digest: revision.digest,
        mediaType: revision.mediaType,
        extractor: info.extractor,
        extractedAt: Date.now(),
      };
      const timeout = AbortSignal.timeout(DOCUMENT_LIMITS.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const partial = await EXTRACTORS[info.kind](bytes, combined, this.stopped);
      // A stop() that lands mid-extraction must not leave a ready record behind:
      // refuse to cache or announce text extracted after shutdown began.
      if (this.stopped) fail('shutting_down', 'Host is stopping', 503);
      const record = truncateRecord(
        { ...base, state: partial.state, truncated: partial.truncated === true },
        partial.text,
        partial.parts,
        partial.limitations,
      );
      this.store.event(revision.botId ?? null, revision.sourceRun ?? null, 'document.extracted', {
        revisionId: revision.id,
        digest: revision.digest,
        state: record.state,
        chars: record.text.length,
      });
      this.cache.set(key, record);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
      return record;
    } catch (e) {
      if (e?.tag) throw e;
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
        fail('cancelled', 'Extraction cancelled or timed out', 409);
      return {
        revisionId: revision.id,
        digest: revision.digest,
        mediaType: revision.mediaType,
        state: 'unavailable',
        text: '',
        truncated: false,
        parts: [],
        extractor: info.extractor,
        extractedAt: Date.now(),
        limitations: [`extraction failed: ${(e?.message ?? 'unknown error').slice(0, 200)}`],
      };
    } finally {
      this.active = Math.max(0, this.active - 1);
    }
  }
  async excerpt(revision, maxChars = 20000) {
    const record = await this.extract(revision);
    const text = record.text.slice(0, maxChars);
    return { ...record, text, truncated: record.truncated || record.text.length > text.length };
  }
  stop() {
    this.stopped = true;
    this.cache.clear();
    this.active = 0;
  }
}
