// ==UserScript==
// @name         ChatGPT Memory Reducer (Expandable + IndexedDB)
// @namespace    local.chatgpt.memory.reducer
// @version      0.4.0
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
  const MAX_COMPACT_PER_RUN = 10;
  const OBSERVER_DELAY_MS = 180;
  const PERIODIC_COMPACT_MS = 1500;
  const FLUSH_DELAY_MS = 120;
  const HOT_CACHE_LIMIT = 8;
  const DB_NAME = "chatgpt-memory-reducer";
  const STORE = "messages";
  const FLAG = "data-mr-compacted";

  let seq = 1;
  let dbPromise = null;
  let compactScheduled = null;
  let compactInFlight = false;
  let flushScheduled = null;

  const hotCache = new Map();
  const writeQueue = [];

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

  async function idbPutMany(rows) {
    if (!rows.length) return;
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const row of rows) {
        store.put(row);
      }
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

  function putHotCache(row) {
    if (!row || !row.id) return;
    if (hotCache.has(row.id)) {
      hotCache.delete(row.id);
    }
    hotCache.set(row.id, row);
    if (hotCache.size > HOT_CACHE_LIMIT) {
      const oldestKey = hotCache.keys().next().value;
      hotCache.delete(oldestKey);
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = setTimeout(() => {
      flushScheduled = null;
      flushWrites().catch((err) => console.error("[MR] flush failed:", err));
    }, FLUSH_DELAY_MS);
  }

  async function flushWrites() {
    if (!writeQueue.length) return;
    const batch = writeQueue.splice(0, writeQueue.length);
    await idbPutMany(batch);
  }

  function compactMessage(el) {
    if (!el || el.getAttribute(FLAG) === "1") return;

    const id = `m_${Date.now()}_${seq++}`;
    const role = el.getAttribute("data-message-author-role") || "unknown";
    const html = el.innerHTML;
    const preview = previewOf(el.textContent);
    const row = { id, role, preview, html, ts: Date.now() };

    el.dataset.mrId = id;
    el.setAttribute(FLAG, "1");
    el.innerHTML = compactUI(role, preview, id);

    putHotCache(row);
    writeQueue.push(row);
    scheduleFlush();
  }

  function scheduleCompact(delayMs = OBSERVER_DELAY_MS) {
    clearTimeout(compactScheduled);
    compactScheduled = setTimeout(() => {
      compactScheduled = null;
      runCompact();
    }, delayMs);
  }

  function runCompact() {
    if (compactInFlight) return;
    compactInFlight = true;

    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    if (msgs.length <= KEEP_LATEST) {
      compactInFlight = false;
      return;
    }

    const cutoff = msgs.length - KEEP_LATEST;
    let compacted = 0;
    for (let i = 0; i < cutoff; i += 1) {
      if (compacted >= MAX_COMPACT_PER_RUN) break;
      if (msgs[i].getAttribute(FLAG) === "1") continue;
      compactMessage(msgs[i]);
      compacted += 1;
    }

    compactInFlight = false;

    if (compacted === MAX_COMPACT_PER_RUN) {
      scheduleCompact(30);
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

    const prevLabel = btn.textContent;
    let loading = false;
    try {
      let row = hotCache.get(id);
      if (!row) {
        loading = true;
        btn.disabled = true;
        btn.textContent = "載入中...";
        row = await idbGet(id);
      }
      if (!row) return;
      putHotCache(row);

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
    } finally {
      if (loading && document.contains(btn)) {
        btn.disabled = false;
        btn.textContent = prevLabel || "展開";
      }
    }
  });

  const observer = new MutationObserver(() => {
    scheduleCompact();
  });

  runCompact();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    runCompact();
  }, PERIODIC_COMPACT_MS);
  setInterval(() => {
    flushWrites().catch((err) => console.error("[MR] periodic flush failed:", err));
  }, 2000);
})();
