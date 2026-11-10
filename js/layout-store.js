// Remembers the latest layout per model in IndexedDB, so reopening a model shows it
// as it was left instead of computing it again. A layout of a large model is about
// a megabyte per mode, too much for localStorage; only the most recent MAX_MODELS
// models are kept. Every call resolves (to null on failure): remembering is a
// convenience, and a browser without storage simply lays models out again.

const DB = 'sbml-viz';
const STORE = 'layouts';
const SEEN = 'seen'; // key -> when it was last remembered
const MAX_MODELS = 10;

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
      req.result.createObjectStore(SEEN);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function request(mode, run) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, SEEN], mode);
    const req = run(tx.objectStore(STORE), tx.objectStore(SEEN));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

// { 2: positions, 3: positions } for the model, or null.
export function recallLayout(key) {
  return request('readonly', s => s.get(key)).catch(() => null).then(v => v ?? null);
}

// Rounded to 0.1, which no one can see and which roughly halves the size.
export async function rememberLayout(key, layouts) {
  const round = pos => Object.fromEntries(Object.entries(pos).map(([id, p]) => [id, p.map(v => Math.round(v * 10) / 10)]));
  try {
    await request('readwrite', (s, seen) => {
      seen.put(Date.now(), key);
      return s.put({ 2: round(layouts[2]), 3: round(layouts[3]) }, key);
    });
    await prune();
  } catch {
    // Not remembered this time.
  }
}

export function forgetLayout(key) {
  return request('readwrite', (s, seen) => {
    seen.delete(key);
    return s.delete(key);
  }).catch(() => null);
}

async function prune() {
  const [keys, times] = await Promise.all([
    request('readonly', (s, seen) => seen.getAllKeys()),
    request('readonly', (s, seen) => seen.getAll()),
  ]);
  if (keys.length <= MAX_MODELS) return;
  const old = keys.map((k, i) => [k, times[i]]).sort((a, b) => b[1] - a[1]).slice(MAX_MODELS);
  await request('readwrite', (s, seen) => {
    for (const [k] of old) {
      s.delete(k);
      seen.delete(k);
    }
    return seen.count();
  });
}
