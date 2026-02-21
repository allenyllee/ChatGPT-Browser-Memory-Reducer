// ==UserScript==
// @name         ChatGPT Memory Reducer (Expandable + IndexedDB)
// @namespace    local.chatgpt.memory.reducer
// @version      0.5.15
// @description  Compress old ChatGPT messages to reduce lag, with expandable restore from IndexedDB.
// @author       allenyllee
// @downloadURL  https://gist.github.com/b1e7051e064b4ad8084efa16edc4fbf8/raw/chatgpt-memory-reducer.user.js
// @updateURL    https://gist.github.com/b1e7051e064b4ad8084efa16edc4fbf8/raw/chatgpt-memory-reducer.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const KEEP_LATEST = 10;
  const PREVIEW_CHARS = 320;
  const MAX_COMPACT_PER_RUN = 10;
  const OBSERVER_DELAY_MS = 180;
  const PERIODIC_COMPACT_MS = 1500;
  const FLUSH_DELAY_MS = 120;
  const HOT_CACHE_LIMIT = 8;
  const COLLAPSE_SCROLL_TOP_OFFSET = 72;
  const DB_NAME = "chatgpt-memory-reducer";
  const STORE = "messages";
  const FLAG = "data-mr-compacted";
  const STYLE_ID = "mr-style";
  const FLASH_CLASS = "mr-focus-flash";
  const FLASH_ANIM_MS = 1800;
  const STATUS_ID = "mr-status";
  const INDEX_BADGE_ATTR = "data-mr-index-badge";
  const EXPANDED_CLASS = "mr-expanded-host";
  const EXPANDED_LOCK_ATTR = "data-mr-expanded-lock";
  const SCROLL_BASE_MS = 350;
  const SCROLL_MS_PER_PX = 0.35;
  const SCROLL_MAX_MS = 1800;

  let seq = 1;
  let dbPromise = null;
  let compactScheduled = null;
  let compactInFlight = false;
  let flushScheduled = null;
  let startupDone = false;
  let routeKey = `${location.pathname}${location.search}`;
  let statusTimer = null;
  let statusDotPhase = 0;

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

  function compactUI(role, preview, id, messageIndex, totalMessages) {
    const indexLabel =
      Number.isInteger(messageIndex) && Number.isInteger(totalMessages)
        ? `第 ${messageIndex}/${totalMessages} 則`
        : "第 ? 則";
    return `
      <div class="mr-compact-card" style="border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:10px 12px;background:rgba(127,127,127,.08)">
        <div style="font-size:12px;opacity:.8;margin-bottom:6px">已壓縮 ${esc(role)} 訊息 (${indexLabel})</div>
        <div style="white-space:pre-wrap;font-size:13px;line-height:1.45">${esc(preview)}</div>
        <button class="mr-toggle" data-mr-action="expand" data-row-id="${id}" style="margin-top:8px">展開</button>
      </div>
    `;
  }

  function indexLabelOf(messageIndex, totalMessages) {
    if (Number.isInteger(messageIndex) && Number.isInteger(totalMessages)) {
      return `${messageIndex}/${totalMessages}`;
    }
    return "?";
  }

  function resolveMessagePosition(host, fallbackIndex, fallbackTotal) {
    if (Number.isInteger(fallbackIndex) && Number.isInteger(fallbackTotal)) {
      return { messageIndex: fallbackIndex, totalMessages: fallbackTotal };
    }
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const idx = host ? msgs.indexOf(host) : -1;
    if (idx >= 0) {
      return { messageIndex: idx + 1, totalMessages: msgs.length };
    }
    return { messageIndex: fallbackIndex, totalMessages: fallbackTotal };
  }

  function syncAllMessageIndexLabels() {
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const total = msgs.length;
    for (let i = 0; i < total; i += 1) {
      const msg = msgs[i];
      const label = indexLabelOf(i + 1, total);
      msg.dataset.mrIndexLabel = label;
      ensureStickyIndexBadge(msg, label);
    }
  }

  function ensureStickyIndexBadge(host, label) {
    if (!host) return;
    let badge = host.querySelector(`:scope > [${INDEX_BADGE_ATTR}="1"]`);
    if (!badge) {
      badge = document.createElement("div");
      badge.setAttribute(INDEX_BADGE_ATTR, "1");
      badge.setAttribute("title", "捲動到這則對話頂端");
      host.prepend(badge);
    }
    if (badge.textContent !== label) {
      badge.textContent = label;
    }
  }

  function ensureInlineCollapseButton(host) {
    if (!host || host.getAttribute(FLAG) === "1") return;
    if (host.querySelector("[data-mr-control='inline-collapse']")) return;
    const control = document.createElement("div");
    control.setAttribute("data-mr-control", "inline-collapse");
    control.style.cssText = "margin-top:8px;display:flex;justify-content:flex-end;";
    control.innerHTML =
      '<button class="mr-inline-collapse" type="button" style="font-size:12px;opacity:.85;padding:4px 8px;border:1px solid rgba(128,128,128,.35);border-radius:8px;background:transparent;cursor:pointer;">收合此則</button>';
    host.appendChild(control);
  }

  function getMessageSnapshot(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("[data-mr-control], [data-mr-index-badge]").forEach((n) => n.remove());
    return {
      html: clone.innerHTML,
      text: clone.textContent || "",
    };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${EXPANDED_CLASS} {
        width: 100%;
        max-width: 100%;
        min-width: 0;
        overflow-x: visible;
      }
      .${EXPANDED_CLASS} pre,
      .${EXPANDED_CLASS} code,
      .${EXPANDED_CLASS} table,
      .${EXPANDED_CLASS} img {
        max-width: 100%;
      }
      .${EXPANDED_CLASS} pre,
      .${EXPANDED_CLASS} table {
        overflow-x: auto;
        display: block;
      }
      .${EXPANDED_CLASS} p,
      .${EXPANDED_CLASS} li,
      .${EXPANDED_CLASS} div {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .${FLASH_CLASS} {
        position: relative;
        border-color: rgba(250, 204, 21, 0.95) !important;
        background: rgba(250, 204, 21, 0.18) !important;
        box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.95), 0 0 0 10px rgba(250, 204, 21, 0.24);
        border-radius: 12px;
        animation: mr-focus-fade ${FLASH_ANIM_MS}ms ease-out forwards;
      }
      @keyframes mr-focus-fade {
        0% {
          border-color: rgba(250, 204, 21, 0.95);
          background: rgba(250, 204, 21, 0.18);
          box-shadow: 0 0 0 2px rgba(250, 204, 21, 0.95), 0 0 0 10px rgba(250, 204, 21, 0.24);
        }
        100% {
          border-color: rgba(128, 128, 128, 0.35);
          background: rgba(127, 127, 127, 0.08);
          box-shadow: 0 0 0 0 rgba(250, 204, 21, 0), 0 0 0 0 rgba(250, 204, 21, 0);
        }
      }
      #${STATUS_ID} {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: .2px;
        transition: opacity .22s ease, transform .22s ease;
        opacity: 0;
        transform: translateY(6px);
        pointer-events: none;
      }
      #${STATUS_ID}.show {
        opacity: 1;
        transform: translateY(0);
      }
      #${STATUS_ID}.working {
        color: #7c4a03;
        border: 1px solid rgba(251, 191, 36, .65);
        background: rgba(254, 243, 199, .95);
      }
      #${STATUS_ID}.done {
        color: #065f46;
        border: 1px solid rgba(16, 185, 129, .55);
        background: rgba(209, 250, 229, .95);
      }
      [data-message-author-role][data-mr-index-label] {
        position: relative;
        overflow: visible;
      }
      [data-mr-index-badge="1"] {
        position: sticky;
        top: 56px;
        display: block;
        width: fit-content;
        margin-left: auto;
        margin-right: 10px;
        margin-top: 4px;
        margin-bottom: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1;
        color: rgba(120, 120, 120, 0.98);
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(255, 255, 255, 0.88);
        backdrop-filter: blur(2px);
        font-variant-numeric: tabular-nums;
        pointer-events: auto;
        cursor: pointer;
        user-select: none;
        z-index: 4;
      }
      @media (max-width: 900px) {
        [data-mr-index-badge="1"] {
          top: 52px;
          margin-right: 8px;
          padding: 3px 7px;
          font-size: 10px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureStatusNode() {
    let node = document.getElementById(STATUS_ID);
    if (node) return node;
    node = document.createElement("div");
    node.id = STATUS_ID;
    document.body.appendChild(node);
    return node;
  }

  function showStatus(text, type) {
    const node = ensureStatusNode();
    if (type === "working") {
      startWorkingStatus(node, text);
    } else {
      stopWorkingStatus();
      node.textContent = text;
    }
    node.className = `${type} show`;
  }

  function hideStatus() {
    stopWorkingStatus();
    const node = document.getElementById(STATUS_ID);
    if (!node) return;
    node.classList.remove("show");
  }

  function startWorkingStatus(node, baseText) {
    const target = node || ensureStatusNode();
    stopWorkingStatus();
    statusDotPhase = 0;
    const tick = () => {
      const dots = ".".repeat(statusDotPhase);
      target.textContent = `${baseText}${dots}`;
      statusDotPhase = (statusDotPhase + 1) % 4;
    };
    tick();
    statusTimer = setInterval(tick, 360);
  }

  function stopWorkingStatus() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
  }

  function getFlashTarget(host) {
    if (!host) return null;
    return host.querySelector(".mr-compact-card") || host;
  }

  function flashMessage(host) {
    const target = getFlashTarget(host);
    if (!target) return;
    target.classList.remove(FLASH_CLASS);
    void target.offsetWidth;
    target.classList.add(FLASH_CLASS);
    setTimeout(() => {
      target.classList.remove(FLASH_CLASS);
    }, FLASH_ANIM_MS + 80);
  }

  function estimateScrollDurationMs(fromY, toY) {
    const distance = Math.abs(toY - fromY);
    const estimated = SCROLL_BASE_MS + distance * SCROLL_MS_PER_PX;
    return Math.min(SCROLL_MAX_MS, Math.max(SCROLL_BASE_MS, estimated));
  }

  function getScrollContainer(el) {
    let cur = el ? el.parentElement : null;
    while (cur && cur !== document.body) {
      const style = window.getComputedStyle(cur);
      const overflowY = style.overflowY || "";
      const scrollable = (overflowY === "auto" || overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 1;
      if (scrollable) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getContainerScrollTop(container) {
    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      return window.scrollY || window.pageYOffset || 0;
    }
    return container.scrollTop;
  }

  function scrollContainerTo(container, top, behavior) {
    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      window.scrollTo({ top, behavior });
      return;
    }
    container.scrollTo({ top, behavior });
  }

  function focusMessageTop(host) {
    if (!host) return;
    const container = getScrollContainer(host);
    const startTop = getContainerScrollTop(container);
    const hostRect = host.getBoundingClientRect();
    const containerTop = container === document.scrollingElement || container === document.documentElement || container === document.body
      ? 0
      : container.getBoundingClientRect().top;
    const rawTarget = startTop + (hostRect.top - containerTop) - COLLAPSE_SCROLL_TOP_OFFSET;
    const maxTop = container === document.scrollingElement || container === document.documentElement || container === document.body
      ? Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight)
      : Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(maxTop, Math.max(0, rawTarget));
    const waitMs = estimateScrollDurationMs(startTop, targetTop);

    scrollContainerTo(container, targetTop, "smooth");
    setTimeout(() => {
      flashMessage(host);
    }, waitMs + 120);
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
    maybeCompleteStartupStatus();
  }

  function compactMessage(el, messageIndex, totalMessages) {
    if (!el || el.getAttribute(FLAG) === "1") return;
    if (el.getAttribute(EXPANDED_LOCK_ATTR) === "1") return;
    const pos = resolveMessagePosition(el, messageIndex, totalMessages);

    const id = `m_${Date.now()}_${seq++}`;
    const role = el.getAttribute("data-message-author-role") || "unknown";
    const snapshot = getMessageSnapshot(el);
    const html = snapshot.html;
    const preview = previewOf(snapshot.text);
    const row = {
      id,
      role,
      preview,
      html,
      ts: Date.now(),
      messageIndex: pos.messageIndex,
      totalMessages: pos.totalMessages,
    };

    el.dataset.mrId = id;
    el.dataset.mrIndexLabel = indexLabelOf(row.messageIndex, row.totalMessages);
    el.classList.remove(EXPANDED_CLASS);
    el.removeAttribute(EXPANDED_LOCK_ATTR);
    el.setAttribute(FLAG, "1");
    el.innerHTML = compactUI(role, preview, id, row.messageIndex, row.totalMessages);

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

  function checkRouteChange() {
    const nextKey = `${location.pathname}${location.search}`;
    if (nextKey === routeKey) return;
    routeKey = nextKey;
    startupDone = false;
    showStatus("收合中", "working");
    scheduleCompact(30);
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
    let pending = 0;
    for (let i = 0; i < cutoff; i += 1) {
      if (compacted >= MAX_COMPACT_PER_RUN) break;
      if (msgs[i].getAttribute(FLAG) === "1") continue;
      compactMessage(msgs[i], i + 1, msgs.length);
      compacted += 1;
    }
    for (let i = 0; i < cutoff; i += 1) {
      if (msgs[i].getAttribute(FLAG) !== "1") pending += 1;
    }

    compactInFlight = false;

    if (compacted === MAX_COMPACT_PER_RUN) {
      scheduleCompact(30);
    }
    if (pending > 0 && !startupDone) {
      showStatus("收合中", "working");
    }
    syncAllMessageIndexLabels();
    maybeCompleteStartupStatus();
  }

  function maybeCompleteStartupStatus() {
    if (startupDone) return;
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const cutoff = Math.max(0, msgs.length - KEEP_LATEST);
    let pending = 0;
    for (let i = 0; i < cutoff; i += 1) {
      if (msgs[i].getAttribute(FLAG) !== "1") {
        pending += 1;
        break;
      }
    }
    if (pending > 0) return;
    if (compactInFlight || compactScheduled || flushScheduled || writeQueue.length > 0) return;
    startupDone = true;
    showStatus("收合完成", "done");
    setTimeout(() => {
      hideStatus();
    }, 2200);
  }

  function ensureButtonsForExpandedMessages() {
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    for (const msg of msgs) {
      ensureInlineCollapseButton(msg);
    }
  }

  function renderExpandedMessage(host, row, id) {
    if (!host || !row || !id) return;
    host.removeAttribute(FLAG);
    host.setAttribute(EXPANDED_LOCK_ATTR, "1");
    host.classList.add(EXPANDED_CLASS);
    host.innerHTML = row.html;

    ensureInlineCollapseButton(host);
  }

  async function collapseExpandedMessage(host) {
    if (!host || host.getAttribute(FLAG) === "1") return;
    const existingId = host.dataset.mrId;
    if (existingId) {
      let row = hotCache.get(existingId);
      if (!row) {
        row = await idbGet(existingId);
      }
      if (!row) return;
      putHotCache(row);
      const pos = resolveMessagePosition(host, row.messageIndex, row.totalMessages);
      host.dataset.mrIndexLabel = indexLabelOf(pos.messageIndex, pos.totalMessages);
      host.classList.remove(EXPANDED_CLASS);
      host.removeAttribute(EXPANDED_LOCK_ATTR);
      host.setAttribute(FLAG, "1");
      host.innerHTML = compactUI(row.role, row.preview, existingId, pos.messageIndex, pos.totalMessages);
      focusMessageTop(host);
      return;
    }
    compactMessage(host);
    focusMessageTop(host);
  }

  document.addEventListener("click", async (e) => {
    const indexBadge = e.target.closest(`[${INDEX_BADGE_ATTR}="1"]`);
    if (indexBadge) {
      e.preventDefault();
      e.stopPropagation();
      const host = indexBadge.closest("[data-message-author-role]");
      focusMessageTop(host);
      return;
    }

    const inlineCollapseBtn = e.target.closest(".mr-inline-collapse");
    if (inlineCollapseBtn) {
      e.preventDefault();
      e.stopPropagation();
      const host = inlineCollapseBtn.closest("[data-message-author-role]");
      await collapseExpandedMessage(host);
      return;
    }

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
        renderExpandedMessage(host, row, id);
      } else {
        const pos = resolveMessagePosition(host, row.messageIndex, row.totalMessages);
        host.dataset.mrIndexLabel = indexLabelOf(pos.messageIndex, pos.totalMessages);
        host.classList.remove(EXPANDED_CLASS);
        host.removeAttribute(EXPANDED_LOCK_ATTR);
        host.innerHTML = compactUI(row.role, row.preview, id, pos.messageIndex, pos.totalMessages);
        host.setAttribute(FLAG, "1");
        focusMessageTop(host);
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
    checkRouteChange();
    syncAllMessageIndexLabels();
    ensureButtonsForExpandedMessages();
    scheduleCompact();
  });

  ensureStyles();
  showStatus("收合中", "working");
  syncAllMessageIndexLabels();
  ensureButtonsForExpandedMessages();
  runCompact();
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    checkRouteChange();
    runCompact();
  }, PERIODIC_COMPACT_MS);
  setInterval(() => {
    flushWrites().catch((err) => console.error("[MR] periodic flush failed:", err));
  }, 2000);
})();
