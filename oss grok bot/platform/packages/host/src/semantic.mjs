import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validate } from './product.mjs';
import { fail, id } from './store.mjs';

export const SEMANTIC_DIMS = 256;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript)$|image\/svg\+xml$)/;

const tokenize = (text) => text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [];

export function hashVector(text, dims = SEMANTIC_DIMS) {
  const vector = new Float64Array(dims);
  for (const token of tokenize(text)) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest.readUInt32BE(0) % dims;
    vector[index] += 1;
    const second = digest.readUInt32BE(4) % dims;
    vector[second] += 0.5;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / norm);
}

const cosine = (left, right) => {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
  return sum;
};

export class Semantic {
  constructor(store, product, documents = null, vault = null) {
    this.store = store;
    this.product = product;
    this.documents = documents;
    this.vault = vault;
    this.localCache = new Map();
  }
  config(botId) {
    const record = this.store
      .list('semantic_config', botId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!record)
      return {
        botId,
        mode: 'local',
        state: 'ready',
        detail:
          'Token-hash similarity ranking over this Bot’s text and extracted document text. This is not a neural embedding model.',
      };
    return record;
  }
  configure(botId, input) {
    const value = validate(
      z
        .object({
          mode: z.enum(['local', 'endpoint']),
          endpoint: z
            .url()
            .refine((v) => {
              let url;
              try {
                url = new URL(v);
              } catch {
                return false;
              }
              if (url.username || url.password) return false;
              if (url.protocol === 'https:') return true;
              if (url.protocol !== 'http:') return false;
              // Plain HTTP is loopback-only so vault-backed secrets never cross a
              // network in cleartext; local embedding servers (e.g. Ollama) keep working.
              return (
                url.hostname === 'localhost' ||
                url.hostname === '::1' ||
                url.hostname === '[::1]' ||
                /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
              );
            }, 'Use an HTTPS URL, or plain HTTP only for a loopback host, without embedded credentials')
            .optional(),
          model: z.string().trim().min(1).max(256).optional(),
          apiKey: z.string().max(4096).optional(),
          revision: z.number().int().optional(),
        })
        .strict(),
      input,
    );
    const previous = this.store.list('semantic_config', botId)[0] ?? null;
    if (previous && previous.revision !== value.revision)
      fail('stale_revision', 'Semantic configuration changed; refresh before saving', 409);
    if (value.mode === 'endpoint' && (!value.endpoint || !value.model))
      fail('invalid_input', 'Endpoint mode requires an embeddings URL and model name');
    const { apiKey, ...rest } = value;
    let secretRef = previous?.secretRef ?? null;
    if (apiKey) {
      if (!this.vault) fail('unavailable', 'Credential storage is not attached', 503);
      secretRef = this.vault.save(apiKey);
    }
    return this.store.tx(() => {
      const record = this.store.put(
        'semantic_config',
        {
          id: previous?.id ?? id(),
          botId,
          ...rest,
          secretRef,
          state: value.mode === 'local' ? 'ready' : 'configured',
          detail:
            value.mode === 'local'
              ? 'Token-hash similarity ranking over this Bot’s text and extracted document text. This is not a neural embedding model.'
              : `Neural embeddings via ${value.endpoint} model ${value.model}. Vectors are fetched per query over plain extracted text.`,
        },
        previous?.revision,
      );
      this.store.event(botId, null, 'semantic.configured', { mode: record.mode });
      return { ...record, secretRef: undefined, hasCredential: !!record.secretRef };
    });
  }
  async textOf(revision) {
    if (TEXT_TYPES.test(revision.mediaType) && revision.size <= 2 * 1024 * 1024) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(this.product.bytes(revision));
      } catch {
        return null;
      }
    }
    if (this.documents?.supported(revision.mediaType)) {
      const record = await this.documents.extract(revision);
      if (['ready', 'partial'].includes(record.state) && record.text.trim()) return record.text;
    }
    return null;
  }
  async embed(text, config, secret) {
    if (config.mode === 'local') return { vector: hashVector(text), model: 'token-hash-256' };
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => fail('provider_failure', 'Embeddings endpoint unreachable', 502));
    if (!response.ok)
      fail('provider_failure', `Embeddings endpoint returned ${response.status}`, 502);
    const value = await response.json().catch(() => null);
    const vector = value?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number'))
      fail('provider_failure', 'Embeddings endpoint returned no numeric vector', 502);
    const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
    return { vector: vector.map((n) => n / norm), model: config.model };
  }
  async search(botId, input, secret = '') {
    const value = validate(
      z
        .object({
          query: z.string().min(1).max(500),
          limit: z.number().int().min(1).max(20).default(8),
        })
        .strict(),
      input,
    );
    const config = this.config(botId);
    if (config.mode === 'endpoint' && config.state !== 'configured')
      fail('unavailable', 'Configure an embeddings endpoint before neural similarity search', 409);
    const revisions = this.store
      .list('artifact', botId)
      .filter((artifact) => artifact.state === 'available')
      .map((artifact) => this.store.get(artifact.currentRevisionId, 'artifact_revision'));
    const { vector: queryVector, model } = await this.embed(value.query, config, secret);
    const scored = [],
      examined = [];
    for (const revision of revisions) {
      if (revision.botId !== botId)
        fail('not_authorized', 'Search revision ownership changed', 403);
      const text = await this.textOf(revision);
      if (!text) {
        examined.push({
          revisionId: revision.id,
          name: revision.name,
          coverage: 'not_searched',
          reason: 'No searchable text: binary without document extraction, oversize, or empty.',
        });
        continue;
      }
      // Cache identity covers the exact configuration revision, endpoint and model:
      // switching endpoints or credentials with the same model name must refetch vectors.
      const key = `${revision.id}:${revision.digest}:${config.id}:${config.revision}:${config.mode}:${config.endpoint ?? 'local'}:${model}`;
      let vector = this.localCache.get(key);
      if (!vector || vector.model !== model || vector.dims !== queryVector.length) {
        if (config.mode === 'local') {
          vector = { model, dims: queryVector.length, values: hashVector(text) };
        } else {
          const embedded = await this.embed(text, config, secret);
          vector = { model, dims: embedded.vector.length, values: embedded.vector };
        }
        this.localCache.set(key, vector);
        if (this.localCache.size > 128) this.localCache.delete(this.localCache.keys().next().value);
      }
      if (vector.dims !== queryVector.length)
        fail('provider_failure', 'Embeddings dimension changed mid-search', 502);
      const score = cosine(queryVector, vector.values);
      examined.push({ revisionId: revision.id, name: revision.name, coverage: 'vector_scored' });
      scored.push({
        revisionId: revision.id,
        artifactId: revision.artifactId,
        name: revision.name,
        digest: revision.digest,
        mediaType: revision.mediaType,
        score: Math.round(score * 10000) / 10000,
        excerpt: text.slice(0, 600),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      query: value.query,
      model,
      mode: config.mode,
      matches: scored.slice(0, value.limit),
      examined,
      method:
        config.mode === 'local'
          ? 'Local token-hash cosine similarity over searchable text; deterministic, not neural. Binary files are explicitly unsearched.'
          : `Cosine similarity over ${model} vectors fetched from the configured endpoint. Binary files are explicitly unsearched.`,
    };
  }
}
