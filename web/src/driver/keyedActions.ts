export type ActionResult<T> = { started: false } | { started: true; value: T };

/** 同一实体只运行一个动作；不同实体互不阻塞。 */
export class KeyedActions<K> {
  private readonly active = new Set<K>();

  snapshot(): ReadonlySet<K> {
    return new Set(this.active);
  }

  async run<T>(key: K, operation: () => Promise<T>, changed: () => void): Promise<ActionResult<T>> {
    if (this.active.has(key)) return { started: false };
    this.active.add(key);
    try {
      changed();
      return { started: true, value: await operation() };
    } finally {
      this.active.delete(key);
      changed();
    }
  }
}
