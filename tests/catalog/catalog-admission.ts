import { Database } from "bun:sqlite";

/**
 * Observe immediate-transaction admission on a `catalog.db` connection: the
 * Catalog's installation coordination, which repair joins. `before` runs just
 * before the write lock is requested and `admitted` just after it is held.
 * Wrapping the native transaction observes that boundary from outside the
 * Catalog without adding a production hook. Returns the restore.
 */
export function observeCatalogAdmission(hooks: {
  readonly before?: () => void;
  readonly admitted?: () => void;
}): () => void {
  const transaction = Database.prototype.transaction;
  Database.prototype.transaction = function <A extends unknown[], T>(
    this: Database,
    callback: (...args: A) => T,
  ) {
    if (!this.filename.endsWith("catalog.db")) {
      return (transaction<A, T>).call(this, callback);
    }
    let immediate = false;
    const native = (transaction<A, T>).call(this, (...args: A): T => {
      if (immediate) hooks.admitted?.();
      return callback(...args);
    });
    return Object.assign((...args: A): T => native(...args), {
      deferred: native.deferred,
      exclusive: native.exclusive,
      immediate: (...args: A): T => {
        hooks.before?.();
        immediate = true;
        return native.immediate(...args);
      },
    });
  };
  return () => {
    Database.prototype.transaction = transaction;
  };
}
