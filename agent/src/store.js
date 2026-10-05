// Projects live in this browser (IndexedDB): files, chat, and the last changes.

const DB = "buddo-agent";
const STORE = "projects";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const listProjects = async () =>
  ((await run("readonly", (s) => s.getAll())) || []).sort((a, b) => b.updated - a.updated);

export const saveProject = (p) => run("readwrite", (s) => s.put({ ...p, updated: Date.now() }));

export const deleteProject = (id) => run("readwrite", (s) => s.delete(id));

export function newProject(name = "My website") {
  return { id: crypto.randomUUID(), name, files: {}, messages: [], updated: Date.now() };
}
