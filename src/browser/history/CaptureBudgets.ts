import { AsyncLocalStorage } from "node:async_hooks";
import {
  selectedWebNetworkCaptureBudgets,
  type WebNetworkCaptureBudgets,
} from "../../domain/webNetworkCapture.js";

const accepted = new AsyncLocalStorage<Readonly<WebNetworkCaptureBudgets>>();
const defaults = Object.freeze(selectedWebNetworkCaptureBudgets({}));

/** A decoder operation and its asynchronous consumers share immutable admitted facts. */
export const withCaptureBudgets = <T>(
  budgets: WebNetworkCaptureBudgets,
  run: () => T,
): T => accepted.run(Object.freeze({ ...budgets }), run);

/** Standalone format readers use the same defaults as the public operation. */
export const captureBudgets = (): Readonly<WebNetworkCaptureBudgets> =>
  accepted.getStore() ?? defaults;
