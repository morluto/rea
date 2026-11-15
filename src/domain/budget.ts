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

  /** Amount still available. */
  get remaining(): number {
    return this.maximum - this.#used;
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

  /** Return a reservation that was not retained. */
  refund(amount: number): void {
    if (!isAmount(amount))
      throw invariantViolation(
        `Budget refund must be a non-negative safe integer, got ${String(amount)}`,
      );
    this.#used = Math.max(0, this.#used - amount);
  }
}
