import type { StorageAreaLike } from "../../src/platform/storage/storage-area";

export class MemoryStorageArea implements StorageAreaLike {
  private readonly values = new Map<string, unknown>();

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const requested =
      keys === undefined || keys === null
        ? [...this.values.keys()]
        : Array.isArray(keys)
          ? keys
          : [keys];

    return Object.fromEntries(
      requested.flatMap((key) =>
        this.values.has(key) ? [[key, structuredClone(this.values.get(key))]] : [],
      ),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async snapshot(): Promise<Record<string, unknown>> {
    return this.get(null);
  }
}

export class AccessControlledMemoryStorageArea extends MemoryStorageArea {
  readonly accessLevels: Array<"TRUSTED_CONTEXTS"> = [];

  async setAccessLevel(details: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> {
    this.accessLevels.push(details.accessLevel);
  }
}
