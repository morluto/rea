import { invariantViolation } from "./internalInvariant.js";

const isAmount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * One allowance of a counted resource (bytes, records, visits) that a producer
 * charges before it allocates and refunds when it discards a reservation.
 *
 * The budget owns the arithmetic: a charge must be a safe non-negative integer
 * that fits what remains, a refused charge changes nothing, and a refund never
 * raises the remainder above the maximum. Each owner keeps its own limit
 * failure, passed to `charge` as `exhausted`.
 *
 * An owner whose ceiling is advisory may charge past it with
 * `chargeOverCommitting`; the budget then records the excess as
 * `overCommitted`, reports no remainder, and refuses `tryCharge` until refunds
 * bring use back under the maximum.
 */
export class Budget {
  #used = 0;

  constructor(readonly maximum: number) {
    if (!isAmount(maximum))
      throw invariantViolation(
        `Budget maximum must be a non-negative safe integer, got ${String(maximum)}`,
      );
  }

  /** Amount charged and not refunded. */
  get used(): number {
    return this.#used;
  }

  /** Amount still available; zero while over-committed. */
  get remaining(): number {
    return Math.max(0, this.maximum - this.#used);
  }

  /** Amount charged past the maximum by `chargeOverCommitting`. */
  get overCommitted(): number {
    return Math.max(0, this.#used - this.maximum);
  }

  /** Charge `amount` when it fits; otherwise charge nothing and return false. */
  tryCharge(amount: number): boolean {
    if (!isAmount(amount) || amount > this.remaining) return false;
    this.#used += amount;
    return true;
  }

  /** Charge `amount`, or throw the owner's limit failure without charging. */
  charge(amount: number, exhausted: () => Error): void {
    if (!this.tryCharge(amount)) throw exhausted();
  }

  /**
   * Charge `amount` whether or not it fits, for an owner that reports the
   * excess itself rather than refusing it. Returns the shortfall: the part of
   * `amount` beyond what remained, zero when it fit.
   */
  chargeOverCommitting(amount: number): number {
    if (!isAmount(amount))
      throw invariantViolation(
        `Budget charge must be a non-negative safe integer, got ${String(amount)}`,
      );
    const shortfall = Math.max(0, amount - this.remaining);
    this.#used += amount;
    return shortfall;
  }

  /**
   * Charge `amount` into a cache, evicting entries until it fits. `evict`
   * discards the oldest entry and returns its charged amount, or `undefined`
   * when nothing is left to evict. An amount above the maximum evicts nothing
   * and returns false.
   */
  chargeEvicting(amount: number, evict: () => number | undefined): boolean {
    if (!isAmount(amount) || amount > this.maximum) return false;
    while (amount > this.remaining) {
      const freed = evict();
      if (freed === undefined) return false;
      this.refund(freed);
    }
    return this.tryCharge(amount);
  }

  /**
   * Refund everything charged since `mark`, a value of `used` taken earlier,
   * and return the refunded amount. A mark at or above the current use refunds
   * nothing: restoring never re-charges, because a re-charge could fail.
   */
  restore(mark: number): number {
    const released = Math.max(0, this.#used - mark);
    this.refund(released);
    return released;
  }

  /** Return a reservation that was not retained. */
  refund(amount: number): void {
    if (!isAmount(amount))
      throw invariantViolation(
        `Budget refund must be a non-negative safe integer, got ${String(amount)}`,
      );
    this.#used = Math.max(0, this.#used - amount);
  }
}
