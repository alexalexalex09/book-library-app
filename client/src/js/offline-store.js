(function initHiLibraryOffline(global) {
  const DB_NAME = "hilibrary-offline-v1";
  const SNAPSHOT_STORE = "snapshots";
  const META_STORE = "meta";
  const MEDIA_CACHE = "hilibrary-media-v1";

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE, { keyPath: "userId" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function runTx(storeName, mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      result = work(store);
    });
  }

  function readRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveSnapshot({ userId, email, books, shelves }) {
    if (!userId) return;
    await runTx(SNAPSHOT_STORE, "readwrite", (store) =>
      store.put({
        userId,
        email: email || "",
        books: Array.isArray(books) ? books : [],
        shelves: Array.isArray(shelves) ? shelves : [],
        savedAt: new Date().toISOString(),
      }),
    );
  }

  async function getSnapshot(userId) {
    if (!userId) return null;
    return runTx(SNAPSHOT_STORE, "readonly", (store) =>
      readRequest(store.get(userId)),
    );
  }

  async function setLastUser({ userId, email }) {
    if (!userId) return;
    await runTx(META_STORE, "readwrite", (store) =>
      store.put({ key: "lastUser", userId, email: email || "" }),
    );
  }

  async function getLastUser() {
    return runTx(META_STORE, "readonly", (store) =>
      readRequest(store.get("lastUser")),
    );
  }

  async function clearUser(userId) {
    if (!userId) return;
    await runTx(SNAPSHOT_STORE, "readwrite", (store) => store.delete(userId));
  }

  function toCacheRequest(cacheKey) {
    return new Request(new URL(cacheKey, global.location.origin).toString());
  }

  function isAllowedCacheFetchHost(sourceUrl) {
    try {
      const parsed = new URL(sourceUrl, global.location.origin);
      const host = parsed.host.toLowerCase();
      const origin = parsed.origin.toLowerCase();
      const pageOrigin = global.location.origin.toLowerCase();
      if (origin === pageOrigin) return true;
      return host.endsWith(".supabase.co");
    } catch {
      return false;
    }
  }

  async function getCachedMediaBlobUrl(cacheKey) {
    if (!cacheKey || !("caches" in global)) return "";
    const cache = await caches.open(MEDIA_CACHE);
    const response = await cache.match(toCacheRequest(cacheKey));
    if (!response) return "";
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  async function cacheMediaFromUrl(cacheKey, sourceUrl) {
    if (!cacheKey || !sourceUrl || !("caches" in global)) return "";
    const sourceHost = (() => {
      try {
        return new URL(sourceUrl).host;
      } catch {
        return "invalid";
      }
    })();
    if (!isAllowedCacheFetchHost(sourceUrl)) {
      return "";
    }
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Failed to fetch media (${response.status})`);
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(toCacheRequest(cacheKey), response.clone());
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  async function getOrCacheMediaBlobUrl(cacheKey, sourceUrl) {
    const cached = await getCachedMediaBlobUrl(cacheKey);
    if (cached) return cached;
    if (!sourceUrl) return "";
    try {
      return await cacheMediaFromUrl(cacheKey, sourceUrl);
    } catch (error) {
      console.warn("Failed to cache media:", cacheKey, error?.message || error);
      return "";
    }
  }

  async function prefetchMedia(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const key = entry?.cacheKey;
      const url = entry?.sourceUrl;
      if (!key || !url) continue;
      try {
        await getOrCacheMediaBlobUrl(key, url);
      } catch (error) {
        if (String(error?.name || "").toLowerCase().includes("quota")) break;
      }
    }
  }

  async function clearMediaCache() {
    if (!("caches" in global)) return;
    await caches.delete(MEDIA_CACHE);
  }

  global.HiLibraryOffline = {
    saveSnapshot,
    getSnapshot,
    setLastUser,
    getLastUser,
    clearUser,
    clearMediaCache,
    cacheMediaFromUrl,
    getCachedMediaBlobUrl,
    getOrCacheMediaBlobUrl,
    prefetchMedia,
  };
})(window);
