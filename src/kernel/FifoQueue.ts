/**
 * Arrival-ordered FIFO queue whose dequeue advances a head offset.
 * Compacting once half the backing slots are evicted keeps push/shift
 * amortized O(1) without shifting remaining elements on every dequeue.
 */
export class FifoQueue<T> {
  #items: (T | undefined)[] = [];
  #head = 0;

  get size(): number {
    return this.#items.length - this.#head;
  }

  push(item: T): void {
    this.#items.push(item);
  }

  peek(): T | undefined {
    return this.#items[this.#head];
  }

  shift(): T | undefined {
    if (this.#head >= this.#items.length) return undefined;
    const item = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head += 1;
    if (this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item;
  }

  clear(): void {
    this.#items = [];
    this.#head = 0;
  }

  toArray(): T[] {
    return this.#items.slice(this.#head) as T[];
  }
}
