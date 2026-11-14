import { compositeKey } from "../unicodeCodePointOrder.js";

/** Key an entity by its type, collection, and caller-supplied identifier. */
export const environmentEntityKey = (
  type: string,
  collection: string,
  id: string,
): string => compositeKey([type, collection, id]);

/** Key a collection by its type and caller-supplied collection path. */
export const environmentCollectionKey = (
  type: string,
  collection: string,
): string => compositeKey([type, collection]);
