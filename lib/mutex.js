export class KeyedMutex {
  #chains = new Map();

  async run(key, task) {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    let release;
    const queued = new Promise((resolve) => {
      release = resolve;
    });
    this.#chains.set(key, previous.then(() => queued));
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.#chains.get(key) === queued) {
        this.#chains.delete(key);
      }
    }
  }
}
