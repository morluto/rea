import { z } from 'zod';
import { validate } from './product.mjs';
import { fail, id } from './store.mjs';
const Cursor = z
  .object({ snapshotId: z.string().uuid(), index: z.number().int().nonnegative() })
  .strict();
export class LibrarySearch {
  constructor(store, product, documents = null) {
    Object.assign(this, { store, product, documents });
  }
  async search(botId, input) {
    const value = validate(
      z
        .object({ query: z.string().min(1).max(500), cursor: z.string().max(4000).optional() })
        .strict(),
      input,
    );
    let cursor;
    if (value.cursor) {
      try {
        cursor = validate(
          Cursor,
          JSON.parse(Buffer.from(value.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        fail('invalid_input', 'Invalid library search cursor');
      }
    }
    let snapshot;
    if (cursor) {
      snapshot = this.store.get(cursor.snapshotId, 'library_search_snapshot');
      if (snapshot.botId !== botId)
        fail('not_authorized', 'Search snapshot belongs to another Bot', 403);
      if (snapshot.query !== value.query) fail('invalid_input', 'Keep the same query while paging');
      if (snapshot.expiresAt <= Date.now())
        fail('expired', 'Search snapshot expired; run the search again', 410);
      if (cursor.index > snapshot.revisionIds.length)
        fail('invalid_input', 'Search cursor exceeds its snapshot');
    } else {
      this.store.db
        .prepare(
          "DELETE FROM records WHERE kind='library_search_snapshot' AND json_extract(data,'$.expiresAt')<=?",
        )
        .run(Date.now());
      snapshot = this.store.put('library_search_snapshot', {
        id: id(),
        botId,
        query: value.query,
        expiresAt: Date.now() + 600000,
        revisionIds: this.store
          .list('artifact', botId)
          .filter((artifact) => artifact.state === 'available')
          .map((artifact) => artifact.currentRevisionId),
      });
    }
    const pattern = new RegExp(value.query.replace(/[.*+?^$()|[\]\\]/g, '\\$&'), 'iu');
    const matches = [],
      examined = [];
    let bytesRead = 0,
      nextIndex = cursor?.index ?? 0;
    for (const revisionId of snapshot.revisionIds.slice(nextIndex)) {
      const revision = this.store.get(revisionId, 'artifact_revision');
      if (revision.botId !== botId)
        fail('not_authorized', 'Search revision ownership changed', 403);
      if (
        examined.length >= 20 ||
        bytesRead + Math.min(revision.size, 2 * 1024 * 1024) > 16 * 1024 * 1024
      )
        break;
      nextIndex++;
      const source = {
        revisionId: revision.id,
        artifactId: revision.artifactId,
        name: revision.name,
        digest: revision.digest,
      };
      const documentKind = this.documents?.supported(revision.mediaType);
      if (documentKind) {
        if (examined.length >= 20 || bytesRead > 16 * 1024 * 1024) break;
        let extraction;
        try {
          extraction = await this.documents.extract(revision);
        } catch (e) {
          examined.push({
            ...source,
            coverage: 'not_searched',
            reason: `Document extraction ${e?.tag ?? 'failed'}: ${(e?.message ?? '').slice(0, 160)}`,
          });
          continue;
        }
        bytesRead += extraction.text.length;
        if (!['ready', 'partial'].includes(extraction.state) || !extraction.text) {
          examined.push({
            ...source,
            coverage: 'not_searched',
            reason: `Document extraction ${extraction.state}: ${extraction.limitations.join('; ').slice(0, 200)}`,
          });
          continue;
        }
        examined.push({
          ...source,
          coverage: 'extracted_document_text',
          bytes: extraction.text.length,
          extractor: extraction.extractor,
          limitations: extraction.limitations,
        });
        const match = pattern.exec(extraction.text);
        if (match) {
          const start = Math.max(0, match.index - 160),
            end = Math.min(extraction.text.length, match.index + match[0].length + 300);
          matches.push({
            ...source,
            offset: match.index,
            offsetUnit: 'UTF-16 code units of extracted document text, not original bytes',
            excerpt: extraction.text.slice(start, end),
            excerptStart: start,
            excerptEnd: end,
            extractedBy: extraction.extractor,
            extractionState: extraction.state,
            extractionLimitations: extraction.limitations,
          });
        }
        continue;
      }
      if (
        !/^(text\/|application\/(json|xml|javascript)$|image\/svg\+xml$)/.test(
          revision.mediaType,
        ) ||
        revision.size > 2 * 1024 * 1024
      ) {
        examined.push({
          ...source,
          coverage: 'not_searched',
          reason:
            'Only UTF-8 text revisions up to 2 MiB and extracted PDF/Office document text are searched; other binary files are explicitly unsearched.',
        });
        continue;
      }
      let content;
      try {
        const bytes = this.product.bytes(revision);
        bytesRead += bytes.length;
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        examined.push({
          ...source,
          coverage: 'not_searched',
          reason: 'Original bytes are unavailable or are not valid UTF-8.',
        });
        continue;
      }
      const match = pattern.exec(content);
      examined.push({ ...source, coverage: 'complete_text', bytes: revision.size });
      if (match) {
        const start = Math.max(0, match.index - 160),
          end = Math.min(content.length, match.index + match[0].length + 300);
        matches.push({
          ...source,
          offset: match.index,
          offsetUnit: 'UTF-16 code units',
          excerpt: content.slice(start, end),
          excerptStart: start,
          excerptEnd: end,
        });
      }
    }
    const hasMore = nextIndex < snapshot.revisionIds.length;
    return {
      query: value.query,
      snapshotAt: snapshot.createdAt,
      matches,
      examined,
      bytesRead,
      nextCursor: hasMore
        ? Buffer.from(JSON.stringify({ snapshotId: snapshot.id, index: nextIndex })).toString(
            'base64url',
          )
        : null,
      method:
        'Literal phrase search, case-insensitive, over UTF-8 text and extracted PDF/Office document text (document offsets refer to extracted text). Not semantic search; see library_semantic. One source-bearing excerpt per matching current revision as of the first page. Continue until nextCursor is null and inspect not_searched coverage.',
    };
  }
}
