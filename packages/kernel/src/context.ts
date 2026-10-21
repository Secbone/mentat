import type { Disposable, MaybePromise } from "@mentat/core";

type Listener = (...args: unknown[]) => void;

let counter = 0;

/**
 * A scoped context inspired by cordis. Services live in a registry shared
 * across the whole tree (so plugins can depend on each other), while effects,
 * listeners and teardown are scoped: one scope per plugin and per session.
 */
export class Context {
  readonly id: string;
  private readonly parent?: Context;
  private readonly registry: Map<string, Array<{ value: unknown }>>;
  private readonly effects: Array<() => MaybePromise<void>> = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private disposed = false;

  constructor(parent?: Context, id?: string, isolateServices = false) {
    this.parent = parent;
    this.id = id ?? `ctx-${++counter}`;
    this.registry = parent
      ? isolateServices
        ? new Map([...parent.registry].map(([key, stack]) => [key, [...stack]]))
        : parent.registry
      : new Map();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get root(): Context {
    return this.parent ? this.parent.root : this;
  }

  /** Register or override a service for the whole tree. */
  provide<T>(key: string, value: T): Disposable {
    this.assertActive();
    const registration = { value };
    const stack = this.registry.get(key) ?? [];
    stack.push(registration);
    this.registry.set(key, stack);

    const restore = (): void => {
      const current = this.registry.get(key);
      const index = current?.indexOf(registration) ?? -1;
      if (index < 0 || !current) return;
      current.splice(index, 1);
      if (!current.length) this.registry.delete(key);
    };
    this.effects.push(restore);
    return { dispose: restore };
  }

  has(key: string): boolean {
    return this.registry.has(key);
  }

  get<T>(key: string): T {
    if (this.registry.has(key)) return this.registry.get(key)?.at(-1)?.value as T;
    throw new Error(`Service not found: ${key}`);
  }

  /** Register a cleanup to run when this scope disposes. */
  effect(cleanup: () => MaybePromise<void>): Disposable {
    this.assertActive();
    let done = false;
    const dispose = () => {
      if (done) return;
      done = true;
      return cleanup();
    };
    this.effects.push(dispose);
    return { dispose };
  }

  on(event: string, listener: Listener): Disposable {
    this.assertActive();
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  }

  emit(event: string, ...args: unknown[]): void {
    let scope: Context | undefined = this;
    while (scope) {
      const set = scope.listeners.get(event);
      if (set) for (const listener of [...set]) listener(...args);
      scope = scope.parent;
    }
  }

  /** Create a child scope that shares services but isolates effects. */
  fork(id?: string): Context {
    this.assertActive();
    return new Context(this, id);
  }

  /** Task-local registry snapshot: overrides cannot leak to sibling or root scopes. */
  isolate(id?: string): Context {
    this.assertActive();
    return new Context(this, id, true);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const effects = this.effects.splice(0).reverse();
    const failures: unknown[] = [];
    for (const effect of effects) {
      try {
        await effect();
      } catch (error) {
        failures.push(error);
      }
    }
    this.listeners.clear();
    if (failures.length) throw new AggregateError(failures, "context cleanup failed");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`Context already disposed: ${this.id}`);
  }
}
