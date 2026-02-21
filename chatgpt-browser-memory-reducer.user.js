// ==UserScript==
// @name         ChatGPT Browser Memory Reducer (Expandable + IndexedDB)
// @namespace    local.chatgpt.browser.memory.reducer
// @version      0.7.0
// @description  Compress old ChatGPT messages to reduce browser memory usage and lag, with expandable restore from IndexedDB.
// @author       allenyllee
// @downloadURL  https://gist.github.com/b1e7051e064b4ad8084efa16edc4fbf8/raw/chatgpt-browser-memory-reducer.user.js
// @updateURL    https://gist.github.com/b1e7051e064b4ad8084efa16edc4fbf8/raw/chatgpt-browser-memory-reducer.user.js
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
  const INDEX_SYNC_DELAY_IDLE_MS = 300;
  const INDEX_SYNC_DELAY_STREAMING_MS = 1200;
  const PANEL_REPOSITION_DELAY_MS = 120;
  const SECONDARY_GROUP_SIZE = 10;
  const SECONDARY_GROUP_DELAY_MS = 260;
  const COLLAPSE_SCROLL_TOP_OFFSET = 72;
  const DB_NAME = "chatgpt-browser-memory-reducer";
  const STORE = "messages";
  const FLAG = "data-mr-compacted";
  const STYLE_ID = "mr-style";
  const FLASH_CLASS = "mr-focus-flash";
  const FLASH_ANIM_MS = 1800;
  const STATUS_ID = "mr-status";
  const BOOKMARK_PANEL_ID = "mr-bookmark-panel";
  const BOOKMARK_SELECT_ID = "mr-bookmark-select";
  const BOOKMARK_INPUT_ID = "mr-bookmark-input";
  const BOOKMARK_PANEL_MIN_BOTTOM = 56;
  const INDEX_TOOLS_ATTR = "data-mr-index-tools";
  const INDEX_BADGE_ATTR = "data-mr-index-badge";
  const INDEX_ADD_ATTR = "data-mr-index-add";
  const INDEX_VALUE_ATTR = "data-mr-index-value";
  const GROUP_ATTR = "data-mr-group";
  const GROUP_ID_ATTR = "data-mr-group-id";
  const GROUP_MEMBER_ATTR = "data-mr-group-member";
  const GROUP_MANUAL_OPEN_ATTR = "data-mr-group-manual-open";
  const EXPANDED_CLASS = "mr-expanded-host";
  const EXPANDED_LOCK_ATTR = "data-mr-expanded-lock";
  const SCROLL_BASE_MS = 350;
  const SCROLL_MS_PER_PX = 0.35;
  const SCROLL_MAX_MS = 1800;

  let seq = 1;
  let dbPromise = null;
  let compactScheduled = null;
  let compactInFlight = false;
  let fullIndexSyncScheduled = null;
  let secondaryGroupScheduled = null;
  let flushScheduled = null;
  let bookmarkPanelPositionScheduled = null;
  let wasStreaming = false;
  let startupDone = false;
  let routeKey = `${location.pathname}${location.search}`;
  let statusTimer = null;
  let statusDotPhase = 0;
  let bookmarks = [];

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

  function indexFromLabel(label) {
    const m = /^(\d+)\//.exec(String(label || ""));
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
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
    let tools = host.querySelector(`:scope > [${INDEX_TOOLS_ATTR}="1"]`);
    if (!tools) {
      tools = document.createElement("div");
      tools.setAttribute(INDEX_TOOLS_ATTR, "1");
      host.prepend(tools);
    }
    let badge = tools.querySelector(`[${INDEX_BADGE_ATTR}="1"]`);
    let addBtn = tools.querySelector(`[${INDEX_ADD_ATTR}="1"]`);
    const indexValue = indexFromLabel(label) || resolveMessagePosition(host).messageIndex;
    const bookmarked = Number.isInteger(indexValue) && bookmarks.includes(indexValue);
    if (!badge) {
      badge = document.createElement("div");
      badge.setAttribute(INDEX_BADGE_ATTR, "1");
      tools.appendChild(badge);
    }
    if (!addBtn) {
      addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.setAttribute(INDEX_ADD_ATTR, "1");
      addBtn.textContent = "+";
      addBtn.setAttribute("title", "加入書籤");
      tools.appendChild(addBtn);
    }
    const viewLabel = bookmarked ? `${label} ★` : label;
    badge.setAttribute(
      "title",
      bookmarked
        ? "點擊捲動到這則對話頂端。Shift+點擊可取消書籤。"
        : "點擊捲動到這則對話頂端。Shift+點擊可加入書籤。"
    );
    if (Number.isInteger(indexValue)) {
      badge.setAttribute(INDEX_VALUE_ATTR, String(indexValue));
      addBtn.setAttribute(INDEX_VALUE_ATTR, String(indexValue));
    } else {
      badge.removeAttribute(INDEX_VALUE_ATTR);
      addBtn.removeAttribute(INDEX_VALUE_ATTR);
    }
    if (badge.textContent !== viewLabel) {
      badge.textContent = viewLabel;
    }
    addBtn.disabled = bookmarked;
  }

  function getBookmarkStorageKey() {
    return `mr-bookmarks:${routeKey}`;
  }

  function normalizeBookmarks(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const out = [];
    for (const v of input) {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(getBookmarkStorageKey());
      if (!raw) return [];
      return normalizeBookmarks(JSON.parse(raw));
    } catch (err) {
      console.warn("[MR] load bookmarks failed:", err);
      return [];
    }
  }

  function saveBookmarks() {
    try {
      localStorage.setItem(getBookmarkStorageKey(), JSON.stringify(bookmarks));
    } catch (err) {
      console.warn("[MR] save bookmarks failed:", err);
    }
  }

  function rerenderBookmarkSelect() {
    const select = document.getElementById(BOOKMARK_SELECT_ID);
    if (!select) return;
    const previous = Number(select.value);
    if (!bookmarks.length) {
      select.innerHTML = '<option value="">書籤（空）</option>';
      return;
    }
    select.innerHTML =
      '<option value="">選擇書籤編號</option>' +
      bookmarks.map((n) => `<option value="${n}">${n}</option>`).join("");
    if (Number.isInteger(previous) && bookmarks.includes(previous)) {
      select.value = String(previous);
    }
  }

  function rerenderBookmarkDecorations() {
    syncAllMessageIndexLabels();
    rerenderBookmarkSelect();
  }

  function addBookmark(index) {
    if (!Number.isInteger(index) || index <= 0) return false;
    if (bookmarks.includes(index)) return false;
    bookmarks = normalizeBookmarks([...bookmarks, index]);
    saveBookmarks();
    rerenderBookmarkDecorations();
    return true;
  }

  function removeBookmark(index) {
    if (!Number.isInteger(index) || index <= 0) return false;
    if (!bookmarks.includes(index)) return false;
    bookmarks = bookmarks.filter((n) => n !== index);
    saveBookmarks();
    rerenderBookmarkDecorations();
    return true;
  }

  function toggleBookmark(index) {
    if (!Number.isInteger(index) || index <= 0) return null;
    if (bookmarks.includes(index)) {
      removeBookmark(index);
      return false;
    }
    addBookmark(index);
    return true;
  }

  function jumpToMessageIndex(index) {
    if (!Number.isInteger(index) || index <= 0) return false;
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    let target = msgs[index - 1];
    if (target && target.getAttribute(GROUP_MEMBER_ATTR) === "1") {
      expandSecondaryGroup(target.getAttribute(GROUP_ID_ATTR));
      const refreshed = Array.from(document.querySelectorAll('[data-message-author-role]'));
      target = refreshed[index - 1];
    }
    if (!target) return false;
    focusMessageTop(target);
    return true;
  }

  function ensureBookmarkPanel() {
    let panel = document.getElementById(BOOKMARK_PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = BOOKMARK_PANEL_ID;
      panel.innerHTML = `
        <input id="${BOOKMARK_INPUT_ID}" type="number" min="1" step="1" placeholder="編號">
        <button type="button" data-mr-action="bookmark-add">加入</button>
        <select id="${BOOKMARK_SELECT_ID}"></select>
        <button type="button" data-mr-action="bookmark-remove">刪除</button>
        <button type="button" data-mr-action="group-regroup-all">重收合</button>
      `;
      document.body.appendChild(panel);
    }
    rerenderBookmarkSelect();
    updateBookmarkPanelPosition();
  }

  function updateBookmarkPanelPosition() {
    const panel = document.getElementById(BOOKMARK_PANEL_ID);
    if (!panel) return;
    let bottom = BOOKMARK_PANEL_MIN_BOTTOM;
    const composerTextarea = document.querySelector("form textarea");
    const composerForm = composerTextarea ? composerTextarea.closest("form") : null;
    if (composerForm) {
      const rect = composerForm.getBoundingClientRect();
      const occupiedBottom = Math.max(0, window.innerHeight - rect.top);
      bottom = Math.max(bottom, occupiedBottom + 10);
    }
    panel.style.bottom = `${Math.round(bottom)}px`;
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
    clone.querySelectorAll("[data-mr-control], [data-mr-index-tools], [data-mr-index-badge]").forEach((n) => n.remove());
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
      #${BOOKMARK_PANEL_ID} {
        position: fixed;
        right: 14px;
        bottom: ${BOOKMARK_PANEL_MIN_BOTTOM}px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(2px);
        color: #111827;
      }
      #${BOOKMARK_PANEL_ID} input,
      #${BOOKMARK_PANEL_ID} select,
      #${BOOKMARK_PANEL_ID} button {
        height: 28px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.55);
        background: #fff;
        font-size: 12px;
        color: #111827;
      }
      #${BOOKMARK_PANEL_ID} input::placeholder {
        color: rgba(55, 65, 81, 0.88);
      }
      #${BOOKMARK_PANEL_ID} input {
        width: 68px;
        padding: 0 8px;
      }
      #${BOOKMARK_PANEL_ID} select {
        min-width: 96px;
        max-width: 124px;
        padding: 0 6px;
      }
      #${BOOKMARK_PANEL_ID} button {
        padding: 0 8px;
        cursor: pointer;
      }
      @media (prefers-color-scheme: dark) {
        #${BOOKMARK_PANEL_ID} {
          border-color: rgba(148, 163, 184, 0.35);
          background: rgba(17, 24, 39, 0.92);
          color: #e5e7eb;
        }
        #${BOOKMARK_PANEL_ID} input,
        #${BOOKMARK_PANEL_ID} select,
        #${BOOKMARK_PANEL_ID} button {
          border-color: rgba(148, 163, 184, 0.45);
          background: rgba(31, 41, 55, 0.96);
          color: #e5e7eb;
        }
        #${BOOKMARK_PANEL_ID} input::placeholder {
          color: rgba(209, 213, 219, 0.78);
        }
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
      [data-mr-index-tools="1"] {
        position: sticky;
        top: 56px;
        display: flex;
        width: fit-content;
        margin-left: auto;
        margin-right: 10px;
        margin-top: 4px;
        margin-bottom: 6px;
        gap: 4px;
        pointer-events: none;
        z-index: 4;
      }
      [data-mr-index-badge="1"] {
        display: block;
        width: fit-content;
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
      }
      [data-mr-index-add="1"] {
        pointer-events: auto;
        width: 22px;
        min-width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        background: rgba(255, 255, 255, 0.9);
        color: rgba(82, 82, 82, 0.95);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0;
      }
      [data-mr-index-add="1"]:disabled {
        cursor: default;
        opacity: .6;
      }
      [${GROUP_ATTR}="1"] {
        margin: 8px auto;
        max-width: min(920px, calc(100% - 24px));
        border: 1px dashed rgba(148, 163, 184, 0.7);
        border-radius: 10px;
        background: rgba(148, 163, 184, 0.12);
        padding: 10px 12px;
        color: inherit;
      }
      [${GROUP_ATTR}="1"] .mr-group-meta {
        font-size: 12px;
        opacity: .82;
        margin-bottom: 6px;
      }
      [${GROUP_ATTR}="1"] .mr-group-title {
        font-size: 13px;
        line-height: 1.4;
      }
      [${GROUP_ATTR}="1"] .mr-group-actions {
        margin-top: 8px;
      }
      [${GROUP_ATTR}="1"] button {
        font-size: 12px;
        padding: 4px 9px;
        border-radius: 8px;
        border: 1px solid rgba(128, 128, 128, 0.45);
        background: rgba(255, 255, 255, 0.85);
        cursor: pointer;
      }
      @media (max-width: 900px) {
        #${BOOKMARK_PANEL_ID} {
          right: 8px;
          bottom: ${BOOKMARK_PANEL_MIN_BOTTOM}px;
          left: 8px;
          overflow-x: auto;
          justify-content: flex-start;
        }
        [data-mr-index-tools="1"] {
          top: 52px;
          margin-right: 8px;
        }
        [data-mr-index-badge="1"] {
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

  function getGroupRangeLabel(hosts) {
    if (!hosts || !hosts.length) return "?";
    const firstPos = resolveMessagePosition(hosts[0]);
    const lastPos = resolveMessagePosition(hosts[hosts.length - 1]);
    if (!Number.isInteger(firstPos.messageIndex) || !Number.isInteger(lastPos.messageIndex)) {
      return "?";
    }
    return `${firstPos.messageIndex}-${lastPos.messageIndex}`;
  }

  function createSecondaryGroup(hosts) {
    if (!hosts || hosts.length < SECONDARY_GROUP_SIZE) return;
    const first = hosts[0];
    if (!first || !first.parentElement) return;
    const groupId = `g_${Date.now()}_${seq++}`;
    const rangeLabel = getGroupRangeLabel(hosts);
    const group = document.createElement("div");
    group.setAttribute(GROUP_ATTR, "1");
    group.setAttribute(GROUP_ID_ATTR, groupId);
    group.innerHTML = `
      <div class="mr-group-meta">二級收合（${hosts.length} 則）</div>
      <div class="mr-group-title">已群組第 ${esc(rangeLabel)} 則訊息，降低渲染負擔</div>
      <div class="mr-group-actions">
        <button type="button" data-mr-action="group-expand" data-mr-group-id="${groupId}">展開此群組</button>
      </div>
    `;
    first.parentElement.insertBefore(group, first);
    for (const host of hosts) {
      host.setAttribute(GROUP_MEMBER_ATTR, "1");
      host.setAttribute(GROUP_ID_ATTR, groupId);
      host.style.display = "none";
    }
  }

  function runSecondaryGrouping() {
    if (isStreamingNow()) return;
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const cutoff = Math.max(0, msgs.length - KEEP_LATEST);
    if (cutoff < SECONDARY_GROUP_SIZE) return;
    const bucket = [];
    for (let i = 0; i < cutoff; i += 1) {
      const msg = msgs[i];
      const compacted = msg.getAttribute(FLAG) === "1";
      const expanded = msg.getAttribute(EXPANDED_LOCK_ATTR) === "1";
      const grouped = msg.getAttribute(GROUP_MEMBER_ATTR) === "1";
      const manualOpen = msg.getAttribute(GROUP_MANUAL_OPEN_ATTR) === "1";
      if (!compacted || expanded || grouped || manualOpen) {
        bucket.length = 0;
        continue;
      }
      bucket.push(msg);
      if (bucket.length === SECONDARY_GROUP_SIZE) {
        createSecondaryGroup([...bucket]);
        bucket.length = 0;
      }
    }
  }

  function scheduleSecondaryGrouping(delayMs = SECONDARY_GROUP_DELAY_MS) {
    clearTimeout(secondaryGroupScheduled);
    secondaryGroupScheduled = setTimeout(() => {
      secondaryGroupScheduled = null;
      runSecondaryGrouping();
    }, delayMs);
  }

  function expandSecondaryGroup(groupId) {
    if (!groupId) return;
    const group = document.querySelector(`[${GROUP_ATTR}="1"][${GROUP_ID_ATTR}="${groupId}"]`);
    const members = Array.from(document.querySelectorAll(`[${GROUP_MEMBER_ATTR}="1"][${GROUP_ID_ATTR}="${groupId}"]`));
    for (const host of members) {
      host.style.display = "";
      host.removeAttribute(GROUP_MEMBER_ATTR);
      host.removeAttribute(GROUP_ID_ATTR);
      host.setAttribute(GROUP_MANUAL_OPEN_ATTR, "1");
    }
    if (group) {
      group.remove();
    }
    scheduleFullIndexSync(80);
  }

  function clearSecondaryGroups() {
    const members = Array.from(document.querySelectorAll(`[${GROUP_MEMBER_ATTR}="1"]`));
    for (const host of members) {
      host.style.display = "";
      host.removeAttribute(GROUP_MEMBER_ATTR);
      host.removeAttribute(GROUP_ID_ATTR);
    }
    const manualOpened = Array.from(document.querySelectorAll(`[${GROUP_MANUAL_OPEN_ATTR}]`));
    for (const host of manualOpened) {
      host.removeAttribute(GROUP_MANUAL_OPEN_ATTR);
    }
    const groups = Array.from(document.querySelectorAll(`[${GROUP_ATTR}="1"]`));
    for (const group of groups) {
      group.remove();
    }
  }

  async function regroupAllSecondaryGroups() {
    const expandedHosts = Array.from(document.querySelectorAll(`[${EXPANDED_LOCK_ATTR}="1"]`));
    for (const host of expandedHosts) {
      await collapseExpandedMessage(host, { focus: false });
    }
    const manualOpened = Array.from(document.querySelectorAll(`[${GROUP_MANUAL_OPEN_ATTR}]`));
    for (const host of manualOpened) {
      host.removeAttribute(GROUP_MANUAL_OPEN_ATTR);
    }
    scheduleFullIndexSync(80);
    scheduleSecondaryGrouping(20);
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
    if (nextKey === routeKey) return false;
    clearSecondaryGroups();
    routeKey = nextKey;
    bookmarks = loadBookmarks();
    rerenderBookmarkSelect();
    startupDone = false;
    showStatus("收合中", "working");
    scheduleCompact(30);
    return true;
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
    if (compacted > 0) {
      scheduleFullIndexSync(80);
      scheduleSecondaryGrouping(120);
    }
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

  function scheduleFullIndexSync(delayMs = 300) {
    clearTimeout(fullIndexSyncScheduled);
    fullIndexSyncScheduled = setTimeout(() => {
      fullIndexSyncScheduled = null;
      syncAllMessageIndexLabels();
    }, delayMs);
  }

  function isStreamingNow() {
    return Boolean(
      document.querySelector('button[data-testid="stop-button"]') ||
        document.querySelector('form button[aria-label*="Stop"]') ||
        document.querySelector('form button[aria-label*="停止"]')
    );
  }

  function scheduleBookmarkPanelPosition() {
    if (bookmarkPanelPositionScheduled) return;
    bookmarkPanelPositionScheduled = setTimeout(() => {
      bookmarkPanelPositionScheduled = null;
      updateBookmarkPanelPosition();
    }, PANEL_REPOSITION_DELAY_MS);
  }

  function collectMessageHostsFromNode(node, out) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (node);
    if (el.matches && el.matches("[data-message-author-role]")) {
      out.add(el);
    }
    if (!el.querySelectorAll) return;
    const nested = el.querySelectorAll("[data-message-author-role]");
    for (const msg of nested) {
      out.add(msg);
    }
  }

  function processAddedMessageHosts(records) {
    const hosts = new Set();
    for (const record of records) {
      if (!record || !record.addedNodes || !record.addedNodes.length) continue;
      for (const node of record.addedNodes) {
        collectMessageHostsFromNode(node, hosts);
      }
    }
    if (!hosts.size) return;
    for (const host of hosts) {
      if (!host.dataset.mrIndexLabel) {
        const pos = resolveMessagePosition(host);
        host.dataset.mrIndexLabel = indexLabelOf(pos.messageIndex, pos.totalMessages);
      }
      ensureStickyIndexBadge(host, host.dataset.mrIndexLabel || "?");
      ensureInlineCollapseButton(host);
    }
  }

  function hasMessageMutation(records) {
    for (const record of records) {
      if (!record) continue;
      for (const node of record.addedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = /** @type {Element} */ (node);
        if (el.matches && el.matches("[data-message-author-role]")) return true;
        if (el.querySelector && el.querySelector("[data-message-author-role]")) return true;
      }
      for (const node of record.removedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = /** @type {Element} */ (node);
        if (el.matches && el.matches("[data-message-author-role]")) return true;
        if (el.querySelector && el.querySelector("[data-message-author-role]")) return true;
      }
    }
    return false;
  }

  function renderExpandedMessage(host, row, id) {
    if (!host || !row || !id) return;
    host.removeAttribute(FLAG);
    host.setAttribute(EXPANDED_LOCK_ATTR, "1");
    host.classList.add(EXPANDED_CLASS);
    host.innerHTML = row.html;

    const pos = resolveMessagePosition(host, row.messageIndex, row.totalMessages);
    host.dataset.mrIndexLabel = indexLabelOf(pos.messageIndex, pos.totalMessages);
    ensureStickyIndexBadge(host, host.dataset.mrIndexLabel || "?");
    ensureInlineCollapseButton(host);
  }

  async function collapseExpandedMessage(host, options = {}) {
    const focus = options.focus !== false;
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
      ensureStickyIndexBadge(host, host.dataset.mrIndexLabel || "?");
      if (focus) {
        focusMessageTop(host);
      }
      return;
    }
    compactMessage(host);
    if (focus) {
      focusMessageTop(host);
    }
  }

  document.addEventListener("click", async (e) => {
    const groupExpandBtn = e.target.closest('[data-mr-action="group-expand"]');
    if (groupExpandBtn) {
      e.preventDefault();
      e.stopPropagation();
      expandSecondaryGroup(groupExpandBtn.getAttribute("data-mr-group-id"));
      return;
    }

    const bookmarkPanel = e.target.closest(`#${BOOKMARK_PANEL_ID}`);
    if (bookmarkPanel) {
      const action = e.target.getAttribute("data-mr-action");
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action === "bookmark-add") {
        const input = document.getElementById(BOOKMARK_INPUT_ID);
        const index = Number(input && input.value);
        if (!Number.isInteger(index) || index <= 0) {
          showStatus("請輸入有效編號", "done");
          return;
        }
        if (addBookmark(index)) {
          showStatus(`已加入書籤 #${index}`, "done");
        } else {
          showStatus(`書籤 #${index} 已存在`, "done");
        }
        if (input) input.value = "";
        return;
      }
      if (action === "bookmark-remove") {
        const select = document.getElementById(BOOKMARK_SELECT_ID);
        const index = Number(select && select.value);
        if (!Number.isInteger(index) || index <= 0) {
          showStatus("請先選擇書籤", "done");
          return;
        }
        if (removeBookmark(index)) {
          showStatus(`已刪除書籤 #${index}`, "done");
        } else {
          showStatus(`書籤 #${index} 不存在`, "done");
        }
        return;
      }
      if (action === "group-regroup-all") {
        await regroupAllSecondaryGroups();
        showStatus("已手動重啟二級收合", "done");
      }
      return;
    }

    const indexAddBtn = e.target.closest(`[${INDEX_ADD_ATTR}="1"]`);
    if (indexAddBtn) {
      e.preventDefault();
      e.stopPropagation();
      const badgeIndex = Number(indexAddBtn.getAttribute(INDEX_VALUE_ATTR));
      if (!Number.isInteger(badgeIndex) || badgeIndex <= 0) return;
      if (addBookmark(badgeIndex)) {
        showStatus(`已加入書籤 #${badgeIndex}`, "done");
      } else {
        showStatus(`書籤 #${badgeIndex} 已存在`, "done");
      }
      return;
    }

    const indexBadge = e.target.closest(`[${INDEX_BADGE_ATTR}="1"]`);
    if (indexBadge) {
      e.preventDefault();
      e.stopPropagation();
      const host = indexBadge.closest("[data-message-author-role]");
      const badgeIndex = Number(indexBadge.getAttribute(INDEX_VALUE_ATTR));
      if (e.shiftKey && Number.isInteger(badgeIndex) && badgeIndex > 0) {
        const added = toggleBookmark(badgeIndex);
        if (added === true) showStatus(`已加入書籤 #${badgeIndex}`, "done");
        if (added === false) showStatus(`已取消書籤 #${badgeIndex}`, "done");
        return;
      }
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

  document.addEventListener("change", (e) => {
    const select = e.target.closest(`#${BOOKMARK_SELECT_ID}`);
    if (!select) return;
    const index = Number(select.value);
    if (!Number.isInteger(index) || index <= 0) return;
    if (jumpToMessageIndex(index)) {
      showStatus(`已跳轉到 #${index}`, "done");
    } else {
      showStatus(`找不到 #${index}`, "done");
    }
  });

  const observer = new MutationObserver((records) => {
    const routeChanged = checkRouteChange();
    const streaming = isStreamingNow();
    if (streaming) {
      wasStreaming = true;
      if (routeChanged) {
        processAddedMessageHosts(records);
        scheduleFullIndexSync(INDEX_SYNC_DELAY_STREAMING_MS);
        scheduleCompact(30);
      }
      scheduleBookmarkPanelPosition();
      return;
    }

    if (wasStreaming) {
      wasStreaming = false;
      scheduleFullIndexSync(80);
      scheduleCompact(60);
      scheduleSecondaryGrouping(140);
    }

    const messageMutated = hasMessageMutation(records);
    if (routeChanged || messageMutated) {
      processAddedMessageHosts(records);
      scheduleFullIndexSync(INDEX_SYNC_DELAY_IDLE_MS);
      scheduleSecondaryGrouping();
    }
    scheduleBookmarkPanelPosition();
    if (routeChanged || messageMutated) {
      if (routeChanged) {
        scheduleCompact(30);
      } else {
        scheduleCompact();
      }
    }
  });

  ensureStyles();
  bookmarks = loadBookmarks();
  ensureBookmarkPanel();
  updateBookmarkPanelPosition();
  showStatus("收合中", "working");
  syncAllMessageIndexLabels();
  ensureButtonsForExpandedMessages();
  runCompact();
  scheduleSecondaryGrouping(200);
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    const streaming = isStreamingNow();
    if (!streaming && wasStreaming) {
      wasStreaming = false;
      scheduleFullIndexSync(80);
      scheduleCompact(60);
      scheduleSecondaryGrouping(140);
    }
    checkRouteChange();
    updateBookmarkPanelPosition();
    if (!startupDone && !streaming) {
      runCompact();
    }
    if (!streaming) {
      scheduleSecondaryGrouping();
    }
  }, PERIODIC_COMPACT_MS);
  window.addEventListener("resize", updateBookmarkPanelPosition);
  setInterval(() => {
    flushWrites().catch((err) => console.error("[MR] periodic flush failed:", err));
  }, 2000);
})();
