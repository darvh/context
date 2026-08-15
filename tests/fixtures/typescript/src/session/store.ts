export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** openStore opens (or creates) a session store backed by a single file. */
export function openStore(path: string): Store {
  const data = new Map<string, string>();
  return {
    get(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    set(key: string, value: string) {
      data.set(key, value);
    },
  };
}

export class MemoryStore implements Store {
  private data = new Map<string, string>();
  get(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  set(key: string, value: string) {
    this.data.set(key, value);
  }
}
