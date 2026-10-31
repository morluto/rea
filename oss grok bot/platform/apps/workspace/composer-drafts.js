export const composerKey = ({ accountId, botId, conversationId }) =>
  JSON.stringify([accountId, botId, conversationId]);

// Drafts belong to a rendered composer, never to whichever Bot is selected later.
export class ComposerDrafts {
  records = new Map();
  pending = new Set();
  read(owner) {
    const key = composerKey(owner);
    if (!this.records.has(key)) this.records.set(key, { text: '', revisionIds: [] });
    return this.records.get(key);
  }
  text(owner, text) {
    const prior = this.read(owner);
    if (prior.text !== text) this.records.set(composerKey(owner), { ...prior, text });
  }
  attachments(owner, revisionIds) {
    this.records.set(composerKey(owner), { ...this.read(owner), revisionIds });
  }
  move(from, to) {
    const source = composerKey(from),
      target = composerKey(to);
    if (this.records.has(source)) this.records.set(target, this.records.get(source));
    this.records.delete(source);
    if (this.pending.delete(source)) this.pending.add(target);
  }
  accepted(owner, record) {
    if (this.records.get(composerKey(owner)) === record) this.records.delete(composerKey(owner));
  }
}
