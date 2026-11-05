import { describe, expect, it } from "vitest";

interface LoaderEntry {
  id: string;
  factory(require: (name: string) => unknown): { apply(ctx: unknown): void };
}

describe("Mentat client plugin", () => {
  it("registers a settings section that reads the overview route", async () => {
    let entry: LoaderEntry | undefined;
    (globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load(value: LoaderEntry) {
          entry = value;
        },
      },
    };
    // The browser bundle is plain JavaScript with no declaration file.
    // @ts-expect-error untyped client bundle
    await import("../client.js");
    if (!entry) throw new Error("client bundle did not register");
    const react = {
      createElement: () => null,
      useState: () => [null, () => {}],
      useCallback: (fn: unknown) => fn,
      useEffect: () => {},
    };
    const module = entry.factory((name) => {
      if (name === "react") return react;
      throw new Error(`unexpected module ${name}`);
    });
    const registered: Array<{ name?: string; id?: string; order?: number; label?: string }> = [];
    module.apply({
      slots: {
        inject: (_name: string, callback: () => unknown) => callback(),
        register: (definition: { name?: string; id?: string; order?: number; label?: string }) => {
          registered.push(definition);
          return () => {};
        },
      },
    });
    expect(entry.id).toBe("@mentat/dsh-client");
    expect(registered[0]).toMatchObject({
      name: "settings.section",
      id: "mentat",
      order: 80,
      label: "Mentat",
    });
  });
});
