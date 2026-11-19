import type { CdpConnection, CdpReceivedEvent } from "./CdpConnection.js";
import { selectCdpFrameIdentity } from "./CdpFrameIdentity.js";
import { onCdpTargetEvent } from "./CdpTargetEvents.js";
import {
  CdpDocumentTracker,
  cdpRootDocument,
  compareCdpDocuments,
  type CdpDocumentComparison,
  type CdpDocumentIdentity,
  type CdpTargetSession,
} from "./CdpTargetSession.js";
import { cdpFrameEvent, type CdpFrameEvent } from "./protocol/CdpEvents.js";
import {
  observedFrameUrl,
  type CdpFrameTree,
} from "./protocol/CdpFrameTree.js";

/**
 * What one root-frame navigation event established about the selected
 * document. `unidentified` is a root event whose frame, parent or loader
 * identity could not be read, so the document can no longer be proven; a
 * root event naming another frame is a proven change (`navigated`, `changed`)
 * even when its loader is malformed.
 */
export type CdpRootNavigation =
  | { readonly kind: "unidentified"; readonly frame: CdpFrameEvent }
  /** An unreadable child-frame event: not the selected document, but a coverage gap. */
  | { readonly kind: "unreadable_child"; readonly frame: CdpFrameEvent }
  | {
      readonly kind: "navigated" | "within_document";
      readonly frame: CdpFrameEvent;
      readonly frameId: string;
      readonly comparison: CdpDocumentComparison;
    };

/**
 * The selected target's page generation: one document tracker fed by the
 * target session's root-frame navigation events and by the frame-tree replies
 * its consumers read, plus one per subframe REA has seen commit. Each consumer
 * decides what a navigation means for its evidence (scope, coverage, timeline
 * rows), but none classifies frame identity or compares documents itself.
 */
export class CdpTargetDocument {
  readonly #tracker: CdpDocumentTracker;
  readonly #listeners = new Set<(navigation: CdpRootNavigation) => void>();
  /**
   * Each live subframe's document since it was first seen, by frame and
   * loader only: subframe consumers need a proven change or an unknown
   * loader, never the URL, so a long `data:` URL is not retained. Entries
   * leave with `Page.frameDetached` and are replaced on a proven change.
   */
  readonly #frames = new Map<string, CdpDocumentTracker>();
  readonly #frameListeners = new Set<(frameId: string) => void>();
  readonly #rootFrameBefore = new WeakMap<CdpReceivedEvent, string>();
  #unidentified = false;
  #unsubscribe: (() => void) | undefined;

  constructor(selected: CdpDocumentIdentity) {
    this.#tracker = new CdpDocumentTracker(selected);
  }

  /** Follow the target session's events until `close`. */
  static watch(
    session: {
      readonly connection: Pick<CdpConnection, "onEvent">;
      readonly sessionId: CdpTargetSession["sessionId"];
    },
    selected: CdpDocumentIdentity,
  ): CdpTargetDocument {
    const document = new CdpTargetDocument(selected);
    document.#unsubscribe = onCdpTargetEvent(
      session.connection,
      session.sessionId,
      (event) => document.ingest(event),
    );
    return document;
  }

  /** The document selected for this operation; the evidence subject. */
  get selected(): CdpDocumentIdentity {
    return this.#tracker.selected;
  }

  get current(): CdpDocumentIdentity {
    return this.#tracker.current;
  }

  /** Another root frame or loader was proven since selection. Sticky. */
  get changed(): boolean {
    return this.#tracker.changed;
  }

  /** Some observation lacked the loader needed to prove the document. Sticky. */
  get unknown(): boolean {
    return this.#tracker.unknown;
  }

  /** A root navigation event could not be identified. Sticky. */
  get unidentified(): boolean {
    return this.#unidentified;
  }

  /**
   * The root frame in effect when `event` arrived, before it was applied, so
   * a consumer replaying buffered events scopes each one as it was received.
   */
  rootFrameBefore(event: CdpReceivedEvent): string {
    return this.#rootFrameBefore.get(event) ?? this.#tracker.current.frameId;
  }

  /**
   * Observe a frame-tree reply; undefined when it cannot identify its root.
   * Subframes not seen before start their document here; a reply never
   * replaces a subframe document that navigation events are following.
   */
  observeTree(tree: CdpFrameTree): CdpDocumentComparison | undefined {
    for (const node of tree.frames) {
      const { frameId, identityIssue, parentRelation, parentIssue, loaderId } =
        node.facts;
      if (
        node === tree.root ||
        frameId === null ||
        identityIssue !== null ||
        parentIssue !== null ||
        parentRelation !== "child" ||
        this.#frames.has(frameId)
      )
        continue;
      this.#frames.set(
        frameId,
        new CdpDocumentTracker({
          frameId,
          loaderId: node.facts.loaderIssue === null ? loaderId : undefined,
        }),
      );
    }
    const document = cdpRootDocument(tree);
    return document === undefined ? undefined : this.observe(document);
  }

  /**
   * Compare a reply's document with the selected one directly. A loader
   * learned from an event since selection does not prove continuity with a
   * selection that had none.
   */
  compareSelected(document: CdpDocumentIdentity): CdpDocumentComparison {
    return compareCdpDocuments(this.#tracker.selected, document);
  }

  /**
   * Whether a committed navigation of subframe `frameId` could not be
   * compared with its earlier document (no loader), so what it registered
   * earlier may belong to that document. Cleared only by a proven change.
   */
  frameDocumentUnknown(frameId: string): boolean {
    return this.#frames.get(frameId)?.unknown ?? false;
  }

  /** Receive each subframe whose committed document was proven to change. */
  onFrameDocumentChanged(listener: (frameId: string) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  /** Observe a root document a consumer already identified from a reply. */
  observe(document: CdpDocumentIdentity): CdpDocumentComparison {
    return this.#tracker.observe(document);
  }

  /** Receive each root navigation after the tracker has applied it. */
  onNavigation(listener: (navigation: CdpRootNavigation) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Apply one target event; `watch` routes the session's events here. */
  ingest(event: CdpReceivedEvent): void {
    const current = this.#tracker.current;
    this.#rootFrameBefore.set(event, current.frameId);
    const frame = cdpFrameEvent(event);
    if (frame === undefined) return;
    const { facts } = frame;
    if (facts.kind === "detached") {
      if (facts.identityIssue === null && facts.frameId !== null)
        this.#frames.delete(facts.frameId);
      return;
    }
    // A requested navigation commits nothing; attach and detach carry no document.
    if (facts.kind !== "navigated" && facts.kind !== "within_document") return;
    const identity = selectCdpFrameIdentity(facts, current.frameId);
    if (identity.identityIssue !== null || identity.parentIssue !== null) {
      const unreadableChild =
        identity.selection === "unknown" &&
        identity.parentRelation === "child" &&
        identity.identityIssue !== null;
      this.#notify({
        kind: unreadableChild ? "unreadable_child" : "unidentified",
        frame,
      });
      return;
    }
    if (identity.frameId === null) {
      if (identity.parentRelation !== "child")
        this.#notify({ kind: "unidentified", frame });
      return;
    }
    if (identity.selection === "other" && !identity.isRootReplacement) {
      if (facts.kind === "navigated")
        this.#observeFrame({
          frameId: identity.frameId,
          loaderId: facts.loaderIssue === null ? facts.loaderId : undefined,
        });
      // A same-document navigation keeps a known subframe's document. A
      // subframe first seen this way starts with an unknown loader, so a
      // later commit cannot prove what it registered meanwhile is stale.
      else if (!this.#frames.has(identity.frameId))
        this.#frames.set(
          identity.frameId,
          new CdpDocumentTracker({ frameId: identity.frameId }),
        );
      return;
    }
    const url = observedFrameUrl(frame.url);
    if (facts.loaderIssue !== null) {
      // A malformed loader cannot prove the document, but another root frame
      // still proves a change, which every consumer reports as one.
      const comparison = this.#tracker.observe({
        frameId: identity.frameId,
        url,
      });
      this.#notify(
        comparison === "changed"
          ? { kind: "navigated", frame, frameId: identity.frameId, comparison }
          : { kind: "unidentified", frame },
      );
      return;
    }
    const comparison = this.#tracker.observe(
      facts.kind === "navigated"
        ? { frameId: identity.frameId, loaderId: facts.loaderId, url }
        : // A same-document navigation keeps the document's loader.
          { ...current, url },
    );
    this.#notify({
      kind: facts.kind,
      frame,
      frameId: identity.frameId,
      comparison,
    });
  }

  /** Stop following the session. Safe to repeat. */
  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#listeners.clear();
    this.#frameListeners.clear();
  }

  #observeFrame(observed: CdpDocumentIdentity): void {
    const tracker = this.#frames.get(observed.frameId);
    if (tracker === undefined) {
      this.#frames.set(observed.frameId, new CdpDocumentTracker(observed));
      return;
    }
    if (tracker.observe(observed) !== "changed") return;
    this.#frames.set(observed.frameId, new CdpDocumentTracker(observed));
    for (const listener of this.#frameListeners) listener(observed.frameId);
  }

  #notify(navigation: CdpRootNavigation): void {
    if (navigation.kind === "unidentified") this.#unidentified = true;
    for (const listener of this.#listeners) listener(navigation);
  }
}
