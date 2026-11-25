const dbName = "siwc-extension";
const table = "records";
let database;

function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(table);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    database = undefined;
    throw error;
  });
  return database;
}

async function record(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, mode);
    const request = action(tx.objectStore(table));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export const readRecord = name => record("readonly", store => store.get(name));
export const writeRecord = (name, value) => record("readwrite", store => store.put(value, name));
export const removeRecord = name => record("readwrite", store => store.delete(name));

export async function consumeAttempt(validate) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, "readwrite");
    const store = tx.objectStore(table);
    const lookup = store.get("attempt");
    let result;
    lookup.onsuccess = () => {
      try {
        result = validate(lookup.result);
        store.delete("attempt");
      } catch (error) {
        reject(error);
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sessionKey(mode, create = false) {
  const name = "session-key:" + mode;
  let { [name]: bytes } = await chrome.storage.session.get(name);
  if (!bytes && create) {
    bytes = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    await chrome.storage.session.set({ [name]: bytes });
  }
  if (bytes) return crypto.subtle.importKey("raw", Uint8Array.from(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function loadSession(mode) {
  const name = "session:" + mode;
  const envelope = await readRecord(name);
  if (!envelope) return;
  const key = await sessionKey(mode);
  if (!key) {
    await removeRecord(name);
    return;
  }
  const algorithm = { name: "AES-GCM", iv: envelope.iv, additionalData: encoder.encode(name) };
  const plaintext = await crypto.subtle.decrypt(algorithm, key, envelope.ciphertext);
  return JSON.parse(decoder.decode(plaintext));
}

export async function saveSession(mode, session) {
  const name = "session:" + mode;
  const key = await sessionKey(mode, true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const algorithm = { name: "AES-GCM", iv, additionalData: encoder.encode(name) };
  const ciphertext = await crypto.subtle.encrypt(algorithm, key, encoder.encode(JSON.stringify(session)));
  await writeRecord(name, { iv, ciphertext });
}

export async function removeSession(mode) {
  await chrome.storage.session.remove("session-key:" + mode);
  await removeRecord("session:" + mode);
}
