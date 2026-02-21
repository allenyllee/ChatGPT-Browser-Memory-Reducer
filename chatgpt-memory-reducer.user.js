// ==UserScript==
// @name         ChatGPT Memory Reducer (Expandable + IndexedDB)
// @namespace    local.chatgpt.memory.reducer
// @version      0.3.0
// @description  Compress old ChatGPT messages to reduce lag, with expandable restore from IndexedDB.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const KEEP_LATEST = 24;
  const PREVIEW_CHARS = 320;
  const DB_NAME = "chatgpt-memory-reducer";
  const STORE = "messages";
  const FLAG = "data-mr-compacted";

  let seq = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(row) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  async function idbGet(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function previewOf(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "[空白訊息]";
    if (t.length <= PREVIEW_CHARS) return t;
    return t.slice(0, PREVIEW_CHARS) + " …";
  }

  function compactUI(role, preview, id) {
    return `
      <div style="border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:10px 12px;background:rgba(127,127,127,.08)">
        <div style="font-size:12px;opacity:.8;margin-bottom:6px">已壓縮 ${esc(role)} 訊息</div>
        <div style="white-space:pre-wrap;font-size:13px;line-height:1.45">${esc(preview)}</div>
        <button class="mr-toggle" data-mr-action="expand" data-row-id="${id}" style="margin-top:8px">展開</button>
      </div>
    `;
  }

  async function compactMessage(el) {
    if (!el || el.getAttribute(FLAG) === "1") return;

    const id = `m_${Date.now()}_${seq++}`;
    const role = el.getAttribute("data-message-author-role") || "unknown";
    const html = el.innerHTML;
    const preview = previewOf(el.innerText);

    await idbPut({ id, role, preview, html, ts: Date.now() });

    el.dataset.mrId = id;
    el.setAttribute(FLAG, "1");
    el.innerHTML = compactUI(role, preview, id);
  }

  async function runCompact() {
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    if (msgs.length <= KEEP_LATEST) return;

    const cutoff = msgs.length - KEEP_LATEST;
    for (let i = 0; i < cutoff; i += 1) {
      await compactMessage(msgs[i]);
    }
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".mr-toggle");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const id = btn.dataset.rowId;
    const action = btn.dataset.mrAction;
    const host = btn.closest("[data-mr-id]");

    if (!id || !action || !host) return;

    try {
      const row = await idbGet(id);
      if (!row) return;

      if (action === "expand") {
        host.innerHTML = `
          <div>${row.html}</div>
          <button class="mr-toggle" data-mr-action="collapse" data-row-id="${id}" style="margin-top:8px">收合</button>
        `;
      } else {
        host.innerHTML = compactUI(row.role, row.preview, id);
      }
    } catch (err) {
      console.error("[MR] toggle failed:", err);
    }
  });

  const observer = new MutationObserver(() => {
    clearTimeout(runCompact._t);
    runCompact._t = setTimeout(() => {
      runCompact().catch((err) => console.error("[MR] compact failed:", err));
    }, 600);
  });

  runCompact().catch((err) => console.error("[MR] initial compact failed:", err));
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    runCompact().catch((err) => console.error("[MR] periodic compact failed:", err));
  }, 5000);
})();
