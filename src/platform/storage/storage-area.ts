export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface AccessControlledStorageAreaLike extends StorageAreaLike {
  setAccessLevel(details: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

export interface ExtensionStorageAreasLike {
  local: AccessControlledStorageAreaLike;
  session: AccessControlledStorageAreaLike;
}

function wrapStorageArea(area: StorageAreaLike): StorageAreaLike {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

/** Keep extension globals at the platform boundary, outside repositories. */
export function getExtensionStorageAreas(): {
  local: StorageAreaLike;
  session: StorageAreaLike;
} {
  return {
    local: wrapStorageArea(browser.storage.local),
    session: wrapStorageArea(browser.storage.session),
  };
}

/** Keep extension storage unavailable to content scripts and untrusted contexts. */
export async function initializeStorageAccess(
  storage: ExtensionStorageAreasLike = browser.storage,
): Promise<void> {
  await Promise.all([
    storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
}
