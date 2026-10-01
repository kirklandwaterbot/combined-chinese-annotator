(function initCombinedAnnotatorUserStore(global) {
  "use strict";

  const Core = global.CombinedAnnotatorCore;
  if (!Core) throw new Error("CombinedAnnotatorCore must load before user-store.js");
  const ext = typeof browser !== "undefined" ? browser : chrome;
  const DB_NAME = "combinedAnnotatorUser";
  const DB_VERSION = 1;
  const STORE_VOCAB = "vocab";
  const STORE_CONTEXTS = "contexts";
  const STORE_REVIEWS = "reviews";
  const STORE_CUSTOM = "customDictionary";
  const STORE_META = "meta";
  const SETTINGS_KEY = "settingsV2";
  const PROFILES_KEY = "siteProfiles";
  const MIGRATION_KEY = "userDataMigrationV2";
  const MAX_CONTEXTS_PER_WORD = 5;
  let dbPromise = null;
  let migrationPromise = null;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_VOCAB)) {
          const store = db.createObjectStore(STORE_VOCAB, { keyPath: "id" });
          store.createIndex("normalizedKey", "normalizedKey", { unique: true });
          store.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains(STORE_CONTEXTS)) {
          const store = db.createObjectStore(STORE_CONTEXTS, { keyPath: "id" });
          store.createIndex("wordId", "wordId");
          store.createIndex("savedAt", "savedAt");
        }
        if (!db.objectStoreNames.contains(STORE_REVIEWS)) {
          const store = db.createObjectStore(STORE_REVIEWS, { keyPath: "wordId" });
          store.createIndex("dueAt", "dueAt");
          store.createIndex("state", "state");
        }
        if (!db.objectStoreNames.contains(STORE_CUSTOM)) {
          const store = db.createObjectStore(STORE_CUSTOM, { keyPath: "id" });
          store.createIndex("normalizedKey", "normalizedKey");
          store.createIndex("headword", "headword");
        }
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open user database"));
    });
    return dbPromise;
  }

  async function allFromStore(storeName) {
    const db = await openDb();
    return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  }

  async function getMeta(key) {
    const db = await openDb();
    return requestResult(db.transaction(STORE_META, "readonly").objectStore(STORE_META).get(key));
  }

  async function setMeta(key, value) {
    const db = await openDb();
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put(value, key);
    await transactionDone(tx);
  }

  async function getSettings() {
    const stored = await ext.storage.local.get({ [SETTINGS_KEY]: null, ...Core.DEFAULT_SETTINGS });
    const source = stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object" ? stored[SETTINGS_KEY] : stored;
    const needsV3Defaults = Number(source?.settingsSchemaVersion) < 3;
    const settings = Core.normalizeSettings(needsV3Defaults ? {
      ...source,
      clipboardEditorSupport: true,
      speechBackend: "azure"
    } : source);
    if (!stored[SETTINGS_KEY] || needsV3Defaults) await ext.storage.local.set({ [SETTINGS_KEY]: settings, ...settings });
    return settings;
  }

  async function setSettings(next) {
    const current = await getSettings();
    const settings = Core.normalizeSettings({ ...current, ...(next || {}) });
    await ext.storage.local.set({ [SETTINGS_KEY]: settings, ...settings });
    return settings;
  }

  async function getProfiles() {
    const stored = await ext.storage.local.get(PROFILES_KEY);
    const profiles = stored?.[PROFILES_KEY];
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return {};
    return Object.fromEntries(Object.entries(profiles)
      .map(([hostname, profile]) => [hostname.toLowerCase(), Core.normalizeSiteProfile(profile, hostname)])
      .filter(([, profile]) => profile.hostname));
  }

  async function setProfile(hostname, profile) {
    const key = String(hostname || "").trim().toLowerCase();
    if (!key) throw new Error("A hostname is required");
    const profiles = await getProfiles();
    if (profile == null) delete profiles[key];
    else profiles[key] = Core.normalizeSiteProfile(profile, key);
    await ext.storage.local.set({ [PROFILES_KEY]: profiles });
    return profiles[key] || null;
  }

  function getProfileCandidates(hostname) {
    const key = String(hostname || "").trim().toLowerCase();
    if (!key) return [];
    const parts = key.split(".");
    if (parts.length < 2) return [key];
    const candidates = [];
    for (let i = 0; i <= parts.length - 2; i++) {
      candidates.push(parts.slice(i).join("."));
    }
    candidates.push("." + parts.slice(parts.length - 2).join("."));
    return candidates;
  }

  async function getEffectiveSettings(hostname = "") {
    const [settings, profiles] = await Promise.all([getSettings(), getProfiles()]);
    const candidates = getProfileCandidates(hostname);
    const matchingProfiles = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const profile = profiles[candidates[i]];
      if (profile) matchingProfiles.push(profile);
    }
    let merged = settings;
    for (const profile of matchingProfiles) {
      merged = Core.effectiveSettings(merged, profile);
    }
    const mostSpecific = matchingProfiles.length > 0 ? matchingProfiles[matchingProfiles.length - 1] : null;
    return { settings: merged, profile: mostSpecific, enabled: mostSpecific ? mostSpecific.enabled !== false : true };
  }

  async function addContext(wordId, input, saveSourceUrl) {
    const context = Core.normalizeContext(input, wordId, saveSourceUrl);
    if (!context) return [];
    const db = await openDb();
    const existing = await requestResult(db.transaction(STORE_CONTEXTS, "readonly").objectStore(STORE_CONTEXTS).index("wordId").getAll(wordId));
    const duplicate = existing.find((item) => item.sentence === context.sentence && item.sourceTitle === context.sourceTitle && item.sourceUrl === context.sourceUrl);
    if (duplicate) return existing.sort((a, b) => b.savedAt - a.savedAt);
    const keep = [context, ...existing].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_CONTEXTS_PER_WORD);
    const tx = db.transaction(STORE_CONTEXTS, "readwrite");
    const store = tx.objectStore(STORE_CONTEXTS);
    for (const item of existing) store.delete(item.id);
    for (const item of keep) store.put(item);
    await transactionDone(tx);
    return keep;
  }

  async function contextsForWords(wordIds) {
    const ids = new Set(wordIds || []);
    if (!ids.size) return new Map();
    const all = await allFromStore(STORE_CONTEXTS);
    const map = new Map();
    for (const context of all) {
      if (!ids.has(context.wordId)) continue;
      if (!map.has(context.wordId)) map.set(context.wordId, []);
      map.get(context.wordId).push(context);
    }
    for (const contexts of map.values()) contexts.sort((a, b) => b.savedAt - a.savedAt);
    return map;
  }

  function normalizeReviewHistory(input) {
    if (!Array.isArray(input)) return [];
    return input.slice(-500).map((item) => ({
      rating: ["again", "hard", "good", "known"].includes(item?.rating) ? item.rating : "good",
      ratedAt: Number(item?.ratedAt) || Date.now(),
      before: Core.normalizeReview(item?.before),
      after: Core.normalizeReview(item?.after)
    }));
  }

  async function getReviewRecord(wordId) {
    const db = await openDb();
    return requestResult(db.transaction(STORE_REVIEWS, "readonly").objectStore(STORE_REVIEWS).get(wordId));
  }

  async function getReview(wordId) {
    return Core.normalizeReview(await getReviewRecord(wordId));
  }

  async function saveVocab(input = {}, contextInput = null) {
    const normalized = Core.normalizeVocabEntry(input);
    if (!normalized) throw new Error("A Chinese headword is required");
    const db = await openDb();
    const readTx = db.transaction(STORE_VOCAB, "readonly");
    const existing = await requestResult(readTx.objectStore(STORE_VOCAB).index("normalizedKey").get(normalized.normalizedKey));
    const entry = existing ? {
      ...existing,
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      definitions: Core.uniqueStrings([...(normalized.definitions || []), ...(existing.definitions || [])], 30, 1000),
      tags: Core.uniqueStrings([...(existing.tags || []), ...(normalized.tags || [])], 30, 80),
      note: normalized.note || existing.note,
      updatedAt: Date.now()
    } : normalized;
    delete entry.review;
    const priorReview = existing ? await getReviewRecord(existing.id) : null;
    const review = Core.normalizeReview(priorReview || input.review);
    const tx = db.transaction([STORE_VOCAB, STORE_REVIEWS], "readwrite");
    tx.objectStore(STORE_VOCAB).put(entry);
    tx.objectStore(STORE_REVIEWS).put({ wordId: entry.id, ...review, history: normalizeReviewHistory(priorReview?.history) });
    await transactionDone(tx);
    const settings = await getSettings();
    const contexts = contextInput ? await addContext(entry.id, contextInput, settings.saveSourceUrl) : (await contextsForWords([entry.id])).get(entry.id) || [];
    return { ...entry, review, contexts };
  }

  async function getVocab(options = {}) {
    await ensureMigration();
    const [entries, reviews, contextMap] = await Promise.all([
      allFromStore(STORE_VOCAB),
      allFromStore(STORE_REVIEWS),
      allFromStore(STORE_CONTEXTS).then((contexts) => {
        const map = new Map();
        for (const item of contexts) {
          if (!map.has(item.wordId)) map.set(item.wordId, []);
          map.get(item.wordId).push(item);
        }
        return map;
      })
    ]);
    const reviewMap = new Map(reviews.map((item) => [item.wordId, Core.normalizeReview(item)]));
    const now = Number(options.now) || Date.now();
    const filter = String(options.filter || "all");
    const search = String(options.search || "").trim().toLocaleLowerCase();
    return entries.map((entry) => ({
      ...entry,
      review: reviewMap.get(entry.id) || Core.normalizeReview(),
      contexts: (contextMap.get(entry.id) || []).sort((a, b) => b.savedAt - a.savedAt)
    })).filter((entry) => {
      if (search && ![entry.hanzi, entry.simplified, entry.traditional, entry.pinyin, entry.jyutping, ...(entry.definitions || []), ...(entry.tags || [])].join(" ").toLocaleLowerCase().includes(search)) return false;
      if (filter === "new") return entry.review.state === "new";
      if (filter === "learning") return entry.review.state === "learning";
      if (filter === "known") return entry.review.state === "known";
      if (filter === "due") return entry.review.state !== "known" && entry.review.dueAt != null && entry.review.dueAt <= now;
      return true;
    }).sort((a, b) => {
      const aDue = a.review.dueAt ?? Number.MAX_SAFE_INTEGER;
      const bDue = b.review.dueAt ?? Number.MAX_SAFE_INTEGER;
      return aDue - bDue || b.updatedAt - a.updatedAt;
    });
  }

  async function removeVocab(idOrHanzi) {
    const entries = await allFromStore(STORE_VOCAB);
    const entry = entries.find((item) => item.id === idOrHanzi || item.hanzi === idOrHanzi);
    if (!entry) return getVocab();
    const contexts = (await contextsForWords([entry.id])).get(entry.id) || [];
    const db = await openDb();
    const tx = db.transaction([STORE_VOCAB, STORE_CONTEXTS, STORE_REVIEWS], "readwrite");
    tx.objectStore(STORE_VOCAB).delete(entry.id);
    tx.objectStore(STORE_REVIEWS).delete(entry.id);
    for (const context of contexts) tx.objectStore(STORE_CONTEXTS).delete(context.id);
    await transactionDone(tx);
    return getVocab();
  }

  async function clearVocab() {
    const db = await openDb();
    const tx = db.transaction([STORE_VOCAB, STORE_CONTEXTS, STORE_REVIEWS], "readwrite");
    tx.objectStore(STORE_VOCAB).clear();
    tx.objectStore(STORE_CONTEXTS).clear();
    tx.objectStore(STORE_REVIEWS).clear();
    await transactionDone(tx);
    return [];
  }

  async function getReviewQueue(now = Date.now(), newLimit = 20) {
    const entries = await getVocab({ now });
    const due = entries.filter((entry) => entry.review.state !== "known" && entry.review.dueAt != null && entry.review.dueAt <= now);
    const fresh = entries.filter((entry) => entry.review.state === "new").sort((a, b) => a.createdAt - b.createdAt).slice(0, newLimit);
    const seen = new Set(due.map((entry) => entry.id));
    return [...due, ...fresh.filter((entry) => !seen.has(entry.id))];
  }

  async function rateReview(wordId, rating, now = Date.now()) {
    const prior = await getReviewRecord(wordId);
    const before = Core.normalizeReview(prior);
    const after = Core.rateReview(before, rating, now);
    const undo = { wordId, before, after, ratedAt: now };
    const history = normalizeReviewHistory([...(prior?.history || []), { rating, ratedAt: now, before, after }]);
    const db = await openDb();
    const tx = db.transaction([STORE_REVIEWS, STORE_META], "readwrite");
    tx.objectStore(STORE_REVIEWS).put({ wordId, ...after, history });
    tx.objectStore(STORE_META).put(undo, "lastReviewUndo");
    await transactionDone(tx);
    return after;
  }

  async function undoLastReview() {
    const undo = await getMeta("lastReviewUndo");
    if (!undo?.wordId) return null;
    const prior = await getReviewRecord(undo.wordId);
    const history = normalizeReviewHistory(prior?.history);
    if (history.at(-1)?.ratedAt === undo.ratedAt) history.pop();
    const db = await openDb();
    const tx = db.transaction([STORE_REVIEWS, STORE_META], "readwrite");
    tx.objectStore(STORE_REVIEWS).put({ wordId: undo.wordId, ...Core.normalizeReview(undo.before), history });
    tx.objectStore(STORE_META).delete("lastReviewUndo");
    await transactionDone(tx);
    return { wordId: undo.wordId, review: Core.normalizeReview(undo.before) };
  }

  function normalizeCustomEntry(input = {}) {
    const headword = String(input.headword || input.hanzi || "").trim().slice(0, 80);
    if (!headword) return null;
    const entry = {
      id: String(input.id || Core.stableId("custom")).slice(0, 120),
      headword,
      simplified: String(input.simplified || headword).trim().slice(0, 80),
      traditional: String(input.traditional || headword).trim().slice(0, 80),
      pinyin: String(input.pinyin || "").trim().slice(0, 240),
      jyutping: String(input.jyutping || "").trim().slice(0, 240),
      definitions: Core.uniqueStrings(input.definitions, 30, 1000),
      note: String(input.note || "").trim().slice(0, 4000),
      tags: Core.uniqueStrings(input.tags, 30, 80),
      mode: input.mode === "replace" ? "replace" : "merge",
      updatedAt: Date.now()
    };
    entry.normalizedKey = [entry.headword, entry.pinyin, entry.jyutping].join("|").toLocaleLowerCase();
    return entry;
  }

  async function getCustomEntries(headword = "") {
    const entries = await allFromStore(STORE_CUSTOM);
    if (!headword) return entries.sort((a, b) => b.updatedAt - a.updatedAt);
    const value = String(headword);
    return entries.filter((entry) => entry.headword === value || entry.simplified === value || entry.traditional === value);
  }

  async function saveCustomEntry(input) {
    const entry = normalizeCustomEntry(input);
    if (!entry) throw new Error("A custom headword is required");
    const db = await openDb();
    const tx = db.transaction(STORE_CUSTOM, "readwrite");
    tx.objectStore(STORE_CUSTOM).put(entry);
    await transactionDone(tx);
    return entry;
  }

  async function removeCustomEntry(id) {
    const db = await openDb();
    const tx = db.transaction(STORE_CUSTOM, "readwrite");
    tx.objectStore(STORE_CUSTOM).delete(id);
    await transactionDone(tx);
    return getCustomEntries();
  }

  async function exportUserData() {
    await ensureMigration();
    const [settings, siteProfiles, vocabulary, contexts, reviews, customDictionary] = await Promise.all([
      getSettings(), getProfiles(), allFromStore(STORE_VOCAB), allFromStore(STORE_CONTEXTS), allFromStore(STORE_REVIEWS), allFromStore(STORE_CUSTOM)
    ]);
    return {
      schemaVersion: Core.USER_DATA_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: "Combined Chinese Annotator",
      settings,
      siteProfiles,
      vocabulary,
      contexts,
      reviews,
      customDictionary
    };
  }

  async function importUserData(payload, mode = "merge") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid backup file");
    const replace = mode === "replace";
    const db = await openDb();
    const [existingEntries, existingContexts] = replace ? [[], []] : await Promise.all([allFromStore(STORE_VOCAB), allFromStore(STORE_CONTEXTS)]);
    const existingByKey = new Map(existingEntries.map((entry) => [entry.normalizedKey, entry]));
    const tx = db.transaction([STORE_VOCAB, STORE_CONTEXTS, STORE_REVIEWS, STORE_CUSTOM], "readwrite");
    if (replace) {
      tx.objectStore(STORE_VOCAB).clear();
      tx.objectStore(STORE_REVIEWS).clear();
      tx.objectStore(STORE_CUSTOM).clear();
    }
    tx.objectStore(STORE_CONTEXTS).clear();
    const idMap = new Map();
    const validWordIds = new Set(existingEntries.map((entry) => entry.id));
    for (const raw of Array.isArray(payload.vocabulary) ? payload.vocabulary : []) {
      let entry = Core.normalizeVocabEntry(raw);
      if (!entry) continue;
      const existing = existingByKey.get(entry.normalizedKey);
      if (existing) {
        entry = {
          ...existing,
          ...entry,
          id: existing.id,
          definitions: Core.uniqueStrings([...(entry.definitions || []), ...(existing.definitions || [])], 30, 1000),
          tags: Core.uniqueStrings([...(existing.tags || []), ...(entry.tags || [])], 30, 80)
        };
      }
      idMap.set(raw.id, entry.id);
      validWordIds.add(entry.id);
      const stored = { ...entry };
      delete stored.review;
      tx.objectStore(STORE_VOCAB).put(stored);
    }
    const contextsByWord = new Map();
    for (const raw of [...existingContexts, ...(Array.isArray(payload.contexts) ? payload.contexts : [])]) {
      const wordId = idMap.get(raw.wordId) || raw.wordId;
      if (!validWordIds.has(wordId)) continue;
      const context = Core.normalizeContext({ ...raw, wordId }, wordId, true);
      if (!context) continue;
      const list = contextsByWord.get(wordId) || [];
      const duplicate = list.find((item) => item.sentence === context.sentence && item.sourceTitle === context.sourceTitle && item.sourceUrl === context.sourceUrl);
      if (!duplicate) list.push(context);
      contextsByWord.set(wordId, list);
    }
    for (const contexts of contextsByWord.values()) {
      for (const context of contexts.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_CONTEXTS_PER_WORD)) tx.objectStore(STORE_CONTEXTS).put(context);
    }
    for (const raw of Array.isArray(payload.reviews) ? payload.reviews : []) {
      const wordId = idMap.get(raw.wordId) || raw.wordId;
      if (validWordIds.has(wordId)) tx.objectStore(STORE_REVIEWS).put({ wordId, ...Core.normalizeReview(raw), history: normalizeReviewHistory(raw.history) });
    }
    for (const raw of Array.isArray(payload.customDictionary) ? payload.customDictionary : []) {
      const entry = normalizeCustomEntry(raw);
      if (entry) tx.objectStore(STORE_CUSTOM).put(entry);
    }
    await transactionDone(tx);

    if (replace) {
      const normalized = Core.normalizeSettings(payload.settings || {});
      const profiles = {};
      if (payload.siteProfiles && typeof payload.siteProfiles === "object" && !Array.isArray(payload.siteProfiles)) {
        for (const [hostname, profile] of Object.entries(payload.siteProfiles)) profiles[hostname] = Core.normalizeSiteProfile(profile, hostname);
      }
      await ext.storage.local.set({ [SETTINGS_KEY]: normalized, ...normalized, [PROFILES_KEY]: profiles });
    } else {
      if (payload.settings) await setSettings(payload.settings);
      if (payload.siteProfiles && typeof payload.siteProfiles === "object" && !Array.isArray(payload.siteProfiles)) {
        const profiles = await getProfiles();
        for (const [hostname, profile] of Object.entries(payload.siteProfiles)) profiles[hostname] = Core.normalizeSiteProfile(profile, hostname);
        await ext.storage.local.set({ [PROFILES_KEY]: profiles });
      }
    }
    return { imported: Array.isArray(payload.vocabulary) ? payload.vocabulary.length : 0, mode };
  }
  async function importDelimited(text) {
    const rows = Core.parseDelimited(text);
    let imported = 0;
    const errors = [];
    for (let index = 0; index < rows.length; index++) {
      try {
        await saveVocab(rows[index].entry, rows[index].context);
        imported++;
      } catch (error) {
        errors.push({ row: index + 1, error: error.message || String(error) });
      }
    }
    return { imported, errors, preview: rows.slice(0, 5).map((row) => row.entry) };
  }

  async function ensureMigration() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      const stored = await ext.storage.local.get([MIGRATION_KEY, "savedVocab", "disabledSites", SETTINGS_KEY]);
      if (stored[MIGRATION_KEY] === Core.USER_DATA_SCHEMA_VERSION) return;
      if (!stored[SETTINGS_KEY]) await setSettings(stored);
      const legacyEntries = Array.isArray(stored.savedVocab) ? stored.savedVocab : [];
      for (const entry of legacyEntries) await saveVocab(entry);
      const profiles = await getProfiles();
      for (const hostname of Array.isArray(stored.disabledSites) ? stored.disabledSites : []) {
        const key = String(hostname || "").toLowerCase();
        if (key && !profiles[key]) profiles[key] = Core.normalizeSiteProfile({ enabled: false }, key);
      }
      await ext.storage.local.set({ [PROFILES_KEY]: profiles });
      const verification = await allFromStore(STORE_VOCAB);
      const importedKeys = new Set(verification.map((entry) => entry.normalizedKey));
      const expectedKeys = new Set(legacyEntries.map((entry) => Core.normalizeVocabEntry(entry)?.normalizedKey).filter(Boolean));
      if (![...expectedKeys].every((key) => importedKeys.has(key))) throw new Error("Vocabulary migration verification failed");
      await ext.storage.local.set({ [MIGRATION_KEY]: Core.USER_DATA_SCHEMA_VERSION });
      await ext.storage.local.remove(["savedVocab", "disabledSites"]);
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
    return migrationPromise;
  }

  const api = {
    DB_NAME,
    SETTINGS_KEY,
    PROFILES_KEY,
    openDb,
    ensureMigration,
    getSettings,
    setSettings,
    getProfiles,
    setProfile,
    getProfileCandidates,
    getEffectiveSettings,
    getVocab,
    saveVocab,
    removeVocab,
    clearVocab,
    getReviewQueue,
    rateReview,
    undoLastReview,
    getCustomEntries,
    saveCustomEntry,
    removeCustomEntry,
    exportUserData,
    importUserData,
    importDelimited
  };

  global.CombinedAnnotatorUserStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
