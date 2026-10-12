/** Strict JSON value, safe to persist and replicate. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MaybePromise<T> = T | Promise<T>;

/** Anything that can release a resource. */
export interface Disposable {
  dispose(): MaybePromise<void>;
}

/** Create a {@link Disposable} from a cleanup function. */
export function toDisposable(fn: () => MaybePromise<void>): Disposable {
  let done = false;
  return {
    dispose: () => {
      if (done) return;
      done = true;
      return fn();
    },
  };
}
