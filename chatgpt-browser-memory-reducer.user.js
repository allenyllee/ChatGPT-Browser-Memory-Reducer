// ==UserScript==
// @name         ChatGPT Browser Memory Reducer (Expandable + IndexedDB)
// @namespace    local.chatgpt.browser.memory.reducer
// @version      0.9.0
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
  const BOOKMARK_EMOJI_MENU_ID = "mr-bookmark-emoji-menu";
  const BOOKMARK_EMOJI_INPUT_ID = "mr-bookmark-emoji-input";
  const BOOKMARK_EMOJI_ADD_ATTR = "data-mr-bookmark-emoji-add";
  const BOOKMARK_EMOJI_CHECK_ATTR = "data-mr-bookmark-emoji-check";
  const BOOKMARK_EMOJI_ITEM_ATTR = "data-mr-bookmark-emoji";
  const BOOKMARK_PANEL_MIN_BOTTOM = 56;
  const BOOKMARK_FILTER_MENU_ID = "mr-bookmark-filter-menu";
  const BOOKMARK_FILTER_CHECK_ATTR = "data-mr-bookmark-filter-check";
  const BOOKMARK_FILTER_ITEM_ATTR = "data-mr-bookmark-filter-item";
  const INDEX_TOOLS_ATTR = "data-mr-index-tools";
  const INDEX_TOP_ATTR = "data-mr-index-top";
  const INDEX_BADGE_ATTR = "data-mr-index-badge";
  const INDEX_ADD_ATTR = "data-mr-index-add";
  const INDEX_EMOJI_ROW_ATTR = "data-mr-index-emoji-row";
  const INDEX_VALUE_ATTR = "data-mr-index-value";
  const FILTER_GROUP_ATTR = "data-mr-filter-group";
  const FILTER_GROUP_ID_ATTR = "data-mr-filter-group-id";
  const FILTER_GROUP_MEMBER_ATTR = "data-mr-filter-group-member";
  const FILTER_GROUP_MANUAL_OPEN_ATTR = "data-mr-filter-group-manual-open";
  const EXPANDED_CLASS = "mr-expanded-host";
  const EXPANDED_LOCK_ATTR = "data-mr-expanded-lock";
  const SCROLL_BASE_MS = 350;
  const SCROLL_MS_PER_PX = 0.35;
  const SCROLL_MAX_MS = 1800;
  const DEFAULT_BOOKMARK_EMOJIS = ["⭐", "❤️", "🔥", "✅", "📌"];
  const MAX_EMOJI_TAG_LENGTH = 8;

  let seq = 1;
  let dbPromise = null;
  let compactScheduled = null;
  let compactInFlight = false;
  let fullIndexSyncScheduled = null;
  let bookmarkFilterScheduled = null;
  let bookmarkFilterResetManualPending = false;
  let flushScheduled = null;
  let bookmarkPanelPositionScheduled = null;
  let wasStreaming = false;
  let startupDone = false;
  let routeKey = `${location.pathname}${location.search}`;
  let statusTimer = null;
  let statusDotPhase = 0;
  let bookmarksByIndex = {};
  let bookmarkEmojiCatalog = [...DEFAULT_BOOKMARK_EMOJIS];
  let bookmarkFilterSelected = new Set();
  let bookmarkMenuIndex = null;

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
    let top = tools.querySelector(`[${INDEX_TOP_ATTR}="1"]`);
    if (!top) {
      top = document.createElement("div");
      top.setAttribute(INDEX_TOP_ATTR, "1");
      tools.appendChild(top);
    }
    let badge = top.querySelector(`[${INDEX_BADGE_ATTR}="1"]`);
    let addBtn = top.querySelector(`[${INDEX_ADD_ATTR}="1"]`);
    let emojiRow = tools.querySelector(`[${INDEX_EMOJI_ROW_ATTR}="1"]`);
    const indexValue = indexFromLabel(label) || resolveMessagePosition(host).messageIndex;
    const bookmarkEmojis = Number.isInteger(indexValue) ? getBookmarkEmojis(indexValue) : [];
    const bookmarked = bookmarkEmojis.length > 0;
    if (!badge) {
      badge = document.createElement("div");
      badge.setAttribute(INDEX_BADGE_ATTR, "1");
      top.appendChild(badge);
    }
    if (!addBtn) {
      addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.setAttribute(INDEX_ADD_ATTR, "1");
      addBtn.textContent = "+";
      addBtn.setAttribute("title", "管理 emoji 書籤");
      top.appendChild(addBtn);
    }
    if (!emojiRow) {
      emojiRow = document.createElement("div");
      emojiRow.setAttribute(INDEX_EMOJI_ROW_ATTR, "1");
      tools.appendChild(emojiRow);
    }
    const viewLabel = label;
    badge.setAttribute(
      "title",
      bookmarked
        ? "點擊捲動到這則對話頂端。Shift+點擊切換預設 emoji 書籤。"
        : "點擊捲動到這則對話頂端。Shift+點擊可加入預設 emoji 書籤。"
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
    emojiRow.innerHTML = bookmarkEmojis.map((emoji) => `<span title="${esc(emoji)}">${esc(emoji)}</span>`).join("");
    emojiRow.style.display = bookmarkEmojis.length ? "flex" : "none";
  }

  function getBookmarkStorageKey() {
    return `mr-bookmarks:${routeKey}`;
  }

  function getEmojiCatalogStorageKey() {
    return "mr-bookmark-emoji-catalog:v1";
  }

  function getBookmarkFilterStorageKey() {
    return "mr-bookmark-filter-selection:v1";
  }

  function normalizeEmojiTag(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (value.length > MAX_EMOJI_TAG_LENGTH) return "";
    return value;
  }

  function normalizeEmojiCatalog(input) {
    const source = Array.isArray(input) ? input : [];
    const seen = new Set();
    const out = [];
    for (const item of source) {
      const emoji = normalizeEmojiTag(item);
      if (!emoji || seen.has(emoji)) continue;
      seen.add(emoji);
      out.push(emoji);
    }
    for (const emoji of DEFAULT_BOOKMARK_EMOJIS) {
      if (!seen.has(emoji)) {
        seen.add(emoji);
        out.push(emoji);
      }
    }
    return out;
  }

  function getBookmarkedIndexes() {
    const out = [];
    for (const key of Object.keys(bookmarksByIndex || {})) {
      const index = Number(key);
      const emojis = bookmarksByIndex[key];
      if (!Number.isInteger(index) || index <= 0) continue;
      if (!Array.isArray(emojis) || !emojis.length) continue;
      out.push(index);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function normalizeBookmarksByIndex(input) {
    const out = {};
    if (Array.isArray(input)) {
      for (const value of input) {
        const index = Number(value);
        if (!Number.isInteger(index) || index <= 0) continue;
        out[String(index)] = [DEFAULT_BOOKMARK_EMOJIS[0]];
      }
      return out;
    }
    if (!input || typeof input !== "object") return out;
    for (const [k, v] of Object.entries(input)) {
      const index = Number(k);
      if (!Number.isInteger(index) || index <= 0) continue;
      const source = Array.isArray(v) ? v : [];
      const seen = new Set();
      const emojis = [];
      for (const item of source) {
        const emoji = normalizeEmojiTag(item);
        if (!emoji || seen.has(emoji)) continue;
        seen.add(emoji);
        emojis.push(emoji);
      }
      if (emojis.length) {
        out[String(index)] = emojis;
      }
    }
    return out;
  }

  function mergeUsedEmojisIntoCatalog() {
    const previousCatalog = [...bookmarkEmojiCatalog];
    let changed = false;
    const seen = new Set(bookmarkEmojiCatalog);
    for (const emojis of Object.values(bookmarksByIndex)) {
      if (!Array.isArray(emojis)) continue;
      for (const item of emojis) {
        const emoji = normalizeEmojiTag(item);
        if (!emoji || seen.has(emoji)) continue;
        seen.add(emoji);
        bookmarkEmojiCatalog.push(emoji);
        changed = true;
      }
    }
    if (changed) {
      saveEmojiCatalog();
      reconcileBookmarkFilterSelection(previousCatalog);
    }
  }

  function loadEmojiCatalog() {
    try {
      const raw = localStorage.getItem(getEmojiCatalogStorageKey());
      if (!raw) return normalizeEmojiCatalog([]);
      return normalizeEmojiCatalog(JSON.parse(raw));
    } catch (err) {
      console.warn("[MR] load emoji catalog failed:", err);
      return normalizeEmojiCatalog([]);
    }
  }

  function saveEmojiCatalog() {
    try {
      localStorage.setItem(getEmojiCatalogStorageKey(), JSON.stringify(normalizeEmojiCatalog(bookmarkEmojiCatalog)));
    } catch (err) {
      console.warn("[MR] save emoji catalog failed:", err);
    }
  }

  function loadBookmarkFilterSelection() {
    try {
      const raw = localStorage.getItem(getBookmarkFilterStorageKey());
      if (!raw) {
        return new Set(bookmarkEmojiCatalog);
      }
      const parsed = JSON.parse(raw);
      const source = Array.isArray(parsed) ? parsed : [];
      const next = new Set();
      for (const item of source) {
        const emoji = normalizeEmojiTag(item);
        if (!emoji) continue;
        if (!bookmarkEmojiCatalog.includes(emoji)) continue;
        next.add(emoji);
      }
      return next;
    } catch (err) {
      console.warn("[MR] load bookmark filter failed:", err);
      return new Set(bookmarkEmojiCatalog);
    }
  }

  function saveBookmarkFilterSelection() {
    try {
      localStorage.setItem(getBookmarkFilterStorageKey(), JSON.stringify(Array.from(bookmarkFilterSelected || [])));
    } catch (err) {
      console.warn("[MR] save bookmark filter failed:", err);
    }
  }

  function isBookmarkFilterActive() {
    return Boolean(bookmarkFilterSelected && bookmarkFilterSelected.size > 0);
  }

  function reconcileBookmarkFilterSelection(previousCatalog = []) {
    if (!(bookmarkFilterSelected instanceof Set)) {
      bookmarkFilterSelected = new Set();
    }
    if (!bookmarkFilterSelected.size) return;
    const hadPrevious = Array.isArray(previousCatalog) && previousCatalog.length > 0;
    const wasAllSelected = hadPrevious && previousCatalog.every((emoji) => bookmarkFilterSelected.has(emoji));
    const next = new Set();
    for (const emoji of bookmarkEmojiCatalog) {
      if (bookmarkFilterSelected.has(emoji) || wasAllSelected) {
        next.add(emoji);
      }
    }
    bookmarkFilterSelected = next;
    saveBookmarkFilterSelection();
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(getBookmarkStorageKey());
      if (!raw) return {};
      return normalizeBookmarksByIndex(JSON.parse(raw));
    } catch (err) {
      console.warn("[MR] load bookmarks failed:", err);
      return {};
    }
  }

  function saveBookmarks() {
    try {
      localStorage.setItem(getBookmarkStorageKey(), JSON.stringify(normalizeBookmarksByIndex(bookmarksByIndex)));
    } catch (err) {
      console.warn("[MR] save bookmarks failed:", err);
    }
  }

  function getBookmarkEmojis(index) {
    if (!Number.isInteger(index) || index <= 0) return [];
    const values = bookmarksByIndex[String(index)];
    return Array.isArray(values) ? values : [];
  }

  function setBookmarkEmoji(index, emoji, enabled) {
    if (!Number.isInteger(index) || index <= 0) return false;
    const normalizedEmoji = normalizeEmojiTag(emoji);
    if (!normalizedEmoji) return false;
    const key = String(index);
    const current = getBookmarkEmojis(index);
    const has = current.includes(normalizedEmoji);
    if (enabled && has) return false;
    if (!enabled && !has) return false;
    const next = enabled ? [...current, normalizedEmoji] : current.filter((x) => x !== normalizedEmoji);
    if (next.length) {
      bookmarksByIndex[key] = next;
    } else {
      delete bookmarksByIndex[key];
    }
    if (!bookmarkEmojiCatalog.includes(normalizedEmoji)) {
      bookmarkEmojiCatalog = normalizeEmojiCatalog([...bookmarkEmojiCatalog, normalizedEmoji]);
      saveEmojiCatalog();
    }
    saveBookmarks();
    rerenderBookmarkDecorations();
    scheduleBookmarkFilterApply(40);
    return true;
  }

  function removeAllBookmarkEmojis(index) {
    if (!Number.isInteger(index) || index <= 0) return false;
    const key = String(index);
    if (!bookmarksByIndex[key]) return false;
    delete bookmarksByIndex[key];
    saveBookmarks();
    rerenderBookmarkDecorations();
    scheduleBookmarkFilterApply(40);
    return true;
  }

  function getDefaultBookmarkEmoji() {
    return bookmarkEmojiCatalog[0] || DEFAULT_BOOKMARK_EMOJIS[0];
  }

  function toggleDefaultBookmark(index) {
    if (!Number.isInteger(index) || index <= 0) return null;
    const emoji = getDefaultBookmarkEmoji();
    const enabled = !getBookmarkEmojis(index).includes(emoji);
    const changed = setBookmarkEmoji(index, emoji, enabled);
    if (!changed) return null;
    return enabled;
  }

  function addEmojiToCatalog(rawEmoji) {
    const emoji = normalizeEmojiTag(rawEmoji);
    if (!emoji) return { ok: false, reason: "invalid", emoji: "" };
    if (bookmarkEmojiCatalog.includes(emoji)) return { ok: false, reason: "exists", emoji };
    const previousCatalog = [...bookmarkEmojiCatalog];
    bookmarkEmojiCatalog = normalizeEmojiCatalog([...bookmarkEmojiCatalog, emoji]);
    saveEmojiCatalog();
    reconcileBookmarkFilterSelection(previousCatalog);
    renderBookmarkEmojiMenu();
    renderBookmarkFilterMenu();
    scheduleBookmarkFilterApply(40);
    return { ok: true, reason: "added", emoji };
  }

  function rerenderBookmarkSelect() {
    const select = document.getElementById(BOOKMARK_SELECT_ID);
    if (!select) return;
    const previous = Number(select.value);
    const indexes = getBookmarkedIndexes();
    if (!indexes.length) {
      select.innerHTML = '<option value="">書籤（空）</option>';
      return;
    }
    select.innerHTML =
      '<option value="">選擇書籤編號</option>' +
      indexes.map((n) => `<option value="${n}">${n}</option>`).join("");
    if (Number.isInteger(previous) && indexes.includes(previous)) {
      select.value = String(previous);
    }
  }

  function rerenderBookmarkDecorations() {
    syncAllMessageIndexLabels();
    rerenderBookmarkSelect();
    updateBookmarkFilterButtonLabel();
  }

  function jumpToMessageIndex(index) {
    if (!Number.isInteger(index) || index <= 0) return false;
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    let target = msgs[index - 1];
    if (target && target.getAttribute(FILTER_GROUP_MEMBER_ATTR) === "1") {
      expandBookmarkFilterGroup(target.getAttribute(FILTER_GROUP_ID_ATTR));
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
        <button type="button" data-mr-action="bookmark-add">加入預設</button>
        <select id="${BOOKMARK_SELECT_ID}"></select>
        <button type="button" data-mr-action="bookmark-collapse-visible">收合已展開</button>
        <button type="button" data-mr-action="bookmark-filter-menu">篩選</button>
        <button type="button" data-mr-action="bookmark-remove">清空類別</button>
      `;
      document.body.appendChild(panel);
    }
    rerenderBookmarkSelect();
    updateBookmarkFilterButtonLabel();
    updateBookmarkPanelPosition();
  }

  function updateBookmarkFilterButtonLabel() {
    const panel = document.getElementById(BOOKMARK_PANEL_ID);
    if (!panel) return;
    const btn = panel.querySelector('[data-mr-action="bookmark-filter-menu"]');
    const collapseBtn = panel.querySelector('[data-mr-action="bookmark-collapse-visible"]');
    if (!btn) return;
    if (collapseBtn) {
      collapseBtn.textContent = "收合已展開";
      collapseBtn.setAttribute("title", "在目前篩選條件下，將可見的展開訊息全部收合");
    }
    if (!isBookmarkFilterActive()) {
      btn.textContent = "篩選: 全部";
      btn.setAttribute("title", "未勾選任何類別，顯示全部訊息");
      return;
    }
    btn.textContent = `篩選:${bookmarkFilterSelected.size}`;
    btn.setAttribute("title", "僅顯示所選書籤類別與最後 10 筆訊息");
  }

  function setBookmarkFilterAllSelected(options = {}) {
    bookmarkFilterSelected = new Set(bookmarkEmojiCatalog);
    saveBookmarkFilterSelection();
    renderBookmarkFilterMenu();
    updateBookmarkFilterButtonLabel();
    scheduleBookmarkFilterApply(40, { resetManualOpen: true });
    if (options.showStatus !== false) {
      showStatus("已套用：僅顯示所有書籤類別 + 最後 10 筆", "done");
    }
  }

  function setBookmarkFilterShowAll(options = {}) {
    bookmarkFilterSelected = new Set();
    saveBookmarkFilterSelection();
    renderBookmarkFilterMenu();
    updateBookmarkFilterButtonLabel();
    scheduleBookmarkFilterApply(40, { resetManualOpen: true });
    if (options.showStatus !== false) {
      showStatus("已套用：顯示全部訊息", "done");
    }
  }

  async function collapseExpandedMessagesInCurrentView() {
    const expandedHosts = Array.from(document.querySelectorAll(`[${EXPANDED_LOCK_ATTR}="1"]`));
    let collapsed = 0;
    const hadManualFilterOpen = Boolean(document.querySelector(`[${FILTER_GROUP_MANUAL_OPEN_ATTR}="1"]`));
    for (const host of expandedHosts) {
      const displayNode = getMessageDisplayNode(host) || host;
      if (!displayNode.isConnected) continue;
      if (window.getComputedStyle(displayNode).display === "none") continue;
      await collapseExpandedMessage(host, { focus: false });
      collapsed += 1;
    }
    if (collapsed > 0 || hadManualFilterOpen) {
      scheduleFullIndexSync(60);
      scheduleBookmarkFilterApply(80, { resetManualOpen: true });
    }
    return { collapsed, regrouped: hadManualFilterOpen };
  }

  function ensureBookmarkEmojiMenu() {
    let menu = document.getElementById(BOOKMARK_EMOJI_MENU_ID);
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = BOOKMARK_EMOJI_MENU_ID;
    menu.innerHTML = `
      <div class="mr-bookmark-emoji-title">選擇書籤類別</div>
      <div class="mr-bookmark-emoji-list"></div>
      <div class="mr-bookmark-emoji-addrow">
        <input id="${BOOKMARK_EMOJI_INPUT_ID}" type="text" maxlength="${MAX_EMOJI_TAG_LENGTH}" placeholder="新增 emoji">
        <button type="button" ${BOOKMARK_EMOJI_ADD_ATTR}="1">新增</button>
      </div>
    `;
    document.body.appendChild(menu);
    return menu;
  }

  function ensureBookmarkFilterMenu() {
    let menu = document.getElementById(BOOKMARK_FILTER_MENU_ID);
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = BOOKMARK_FILTER_MENU_ID;
    menu.innerHTML = `
      <div class="mr-bookmark-filter-title">顯示哪些書籤類別</div>
      <div class="mr-bookmark-filter-note">未勾選任何類別時，顯示全部訊息。</div>
      <div class="mr-bookmark-filter-list"></div>
      <div class="mr-bookmark-filter-actions">
        <button type="button" data-mr-action="bookmark-filter-select-all">全選</button>
        <button type="button" data-mr-action="bookmark-filter-clear">全不選</button>
      </div>
    `;
    document.body.appendChild(menu);
    return menu;
  }

  function renderBookmarkFilterMenu() {
    const menu = ensureBookmarkFilterMenu();
    const list = menu.querySelector(".mr-bookmark-filter-list");
    if (!list) return;
    list.innerHTML = bookmarkEmojiCatalog
      .map((emoji) => {
        const checked = bookmarkFilterSelected.has(emoji) ? " checked" : "";
        return `<label><input type="checkbox" ${BOOKMARK_FILTER_CHECK_ATTR}="1" ${BOOKMARK_FILTER_ITEM_ATTR}="${esc(emoji)}"${checked}> <span>${esc(emoji)}</span></label>`;
      })
      .join("");
  }

  function openBookmarkFilterMenu(anchor) {
    closeBookmarkEmojiMenu();
    const menu = ensureBookmarkFilterMenu();
    renderBookmarkFilterMenu();
    menu.style.display = "block";
    positionBookmarkEmojiMenu(anchor, menu);
  }

  function closeBookmarkFilterMenu() {
    const menu = document.getElementById(BOOKMARK_FILTER_MENU_ID);
    if (!menu) return;
    menu.style.display = "none";
  }

  function renderBookmarkEmojiMenu(index = bookmarkMenuIndex) {
    const menu = ensureBookmarkEmojiMenu();
    const targetIndex = Number(index);
    const validIndex = Number.isInteger(targetIndex) && targetIndex > 0 ? targetIndex : null;
    const selected = validIndex ? new Set(getBookmarkEmojis(validIndex)) : new Set();
    const list = menu.querySelector(".mr-bookmark-emoji-list");
    if (!list) return;
    list.innerHTML = bookmarkEmojiCatalog
      .map((emoji) => {
        const checked = selected.has(emoji) ? " checked" : "";
        return `<label><input type="checkbox" ${BOOKMARK_EMOJI_CHECK_ATTR}="1" ${BOOKMARK_EMOJI_ITEM_ATTR}="${esc(emoji)}"${checked}> <span>${esc(emoji)}</span></label>`;
      })
      .join("");
    const title = menu.querySelector(".mr-bookmark-emoji-title");
    if (title) {
      title.textContent = validIndex ? `選擇 #${validIndex} 的書籤類別` : "選擇書籤類別";
    }
  }

  function openBookmarkEmojiMenu(anchor, index) {
    closeBookmarkFilterMenu();
    const menu = ensureBookmarkEmojiMenu();
    bookmarkMenuIndex = Number(index);
    renderBookmarkEmojiMenu(bookmarkMenuIndex);
    menu.style.display = "block";
    positionBookmarkEmojiMenu(anchor, menu);
  }

  function closeBookmarkEmojiMenu() {
    const menu = document.getElementById(BOOKMARK_EMOJI_MENU_ID);
    if (!menu) return;
    menu.style.display = "none";
    bookmarkMenuIndex = null;
  }

  function positionBookmarkEmojiMenu(anchor, menuNode) {
    const menu = menuNode || ensureBookmarkEmojiMenu();
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = 220;
    const pad = 8;
    const top = Math.min(window.innerHeight - 16, rect.bottom + 6);
    const left = Math.max(pad, Math.min(window.innerWidth - width - pad, rect.right - width));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
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
        [data-mr-index-badge="1"],
        [data-mr-index-add="1"],
        [data-mr-index-emoji-row="1"] span {
          border-color: rgba(148, 163, 184, 0.4);
          background: rgba(31, 41, 55, 0.92);
          color: #e5e7eb;
        }
        #${BOOKMARK_EMOJI_MENU_ID} {
          border-color: rgba(148, 163, 184, 0.35);
          background: rgba(17, 24, 39, 0.96);
          color: #e5e7eb;
        }
        #${BOOKMARK_FILTER_MENU_ID} {
          border-color: rgba(148, 163, 184, 0.35);
          background: rgba(17, 24, 39, 0.96);
          color: #e5e7eb;
        }
        #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow input,
        #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow button {
          border-color: rgba(148, 163, 184, 0.45);
          background: rgba(31, 41, 55, 0.96);
          color: #e5e7eb;
        }
        #${BOOKMARK_FILTER_MENU_ID} .mr-bookmark-filter-actions button {
          border-color: rgba(148, 163, 184, 0.45);
          background: rgba(31, 41, 55, 0.96);
          color: #e5e7eb;
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
        display: grid;
        justify-items: end;
        width: fit-content;
        margin-left: auto;
        margin-right: 10px;
        margin-top: 4px;
        margin-bottom: 6px;
        gap: 3px;
        pointer-events: none;
        z-index: 4;
      }
      [data-mr-index-top="1"] {
        display: flex;
        align-items: center;
        gap: 4px;
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
      [data-mr-index-emoji-row="1"] {
        display: none;
        gap: 2px;
        align-items: center;
      }
      [data-mr-index-emoji-row="1"] span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        line-height: 1;
        border-radius: 999px;
        padding: 2px 4px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(255, 255, 255, 0.86);
      }
      #${BOOKMARK_EMOJI_MENU_ID} {
        position: fixed;
        display: none;
        width: 220px;
        z-index: 2147483647;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 14px 38px rgba(15, 23, 42, 0.2);
        backdrop-filter: blur(2px);
        padding: 8px;
        color: #111827;
      }
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-title {
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 6px;
      }
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-list {
        max-height: 160px;
        overflow-y: auto;
        display: grid;
        gap: 4px;
        margin-bottom: 8px;
      }
      #${BOOKMARK_EMOJI_MENU_ID} label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow {
        display: flex;
        gap: 6px;
      }
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow input,
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow button {
        height: 26px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.55);
        background: #fff;
        font-size: 12px;
        color: #111827;
      }
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow input {
        flex: 1;
        min-width: 0;
        padding: 0 8px;
      }
      #${BOOKMARK_EMOJI_MENU_ID} .mr-bookmark-emoji-addrow button {
        padding: 0 8px;
        cursor: pointer;
      }
      #${BOOKMARK_FILTER_MENU_ID} {
        position: fixed;
        display: none;
        width: 220px;
        z-index: 2147483647;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 14px 38px rgba(15, 23, 42, 0.2);
        backdrop-filter: blur(2px);
        padding: 8px;
        color: #111827;
      }
      #${BOOKMARK_FILTER_MENU_ID} .mr-bookmark-filter-title {
        font-size: 12px;
        font-weight: 600;
        margin-bottom: 4px;
      }
      #${BOOKMARK_FILTER_MENU_ID} .mr-bookmark-filter-note {
        font-size: 11px;
        opacity: 0.8;
        margin-bottom: 6px;
      }
      #${BOOKMARK_FILTER_MENU_ID} .mr-bookmark-filter-list {
        max-height: 160px;
        overflow-y: auto;
        display: grid;
        gap: 4px;
        margin-bottom: 8px;
      }
      #${BOOKMARK_FILTER_MENU_ID} label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }
      #${BOOKMARK_FILTER_MENU_ID} .mr-bookmark-filter-actions {
        display: flex;
        gap: 6px;
      }
      #${BOOKMARK_FILTER_MENU_ID} .mr-bookmark-filter-actions button {
        height: 26px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.55);
        background: #fff;
        font-size: 12px;
        color: #111827;
        padding: 0 8px;
        cursor: pointer;
      }
      [${FILTER_GROUP_ATTR}="1"] {
        margin: 8px auto;
        max-width: min(920px, calc(100% - 24px));
        border: 1px dashed rgba(125, 211, 252, 0.8);
        border-radius: 10px;
        background: rgba(186, 230, 253, 0.18);
        padding: 10px 12px;
        color: inherit;
      }
      [${FILTER_GROUP_ATTR}="1"] .mr-group-meta {
        font-size: 12px;
        opacity: .82;
        margin-bottom: 6px;
      }
      [${FILTER_GROUP_ATTR}="1"] .mr-group-title {
        font-size: 13px;
        line-height: 1.4;
      }
      [${FILTER_GROUP_ATTR}="1"] .mr-group-actions {
        margin-top: 8px;
      }
      [${FILTER_GROUP_ATTR}="1"] button {
        font-size: 12px;
        padding: 4px 9px;
        border-radius: 8px;
        border: 1px solid rgba(56, 189, 248, 0.45);
        background: rgba(255, 255, 255, 0.88);
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

  function getMessageDisplayNode(host) {
    if (!host) return null;
    const article = host.closest("article");
    return article || host;
  }

  function setMessageHidden(host, hidden) {
    if (!host) return;
    const displayNode = getMessageDisplayNode(host);
    if (displayNode && displayNode !== host) {
      displayNode.style.display = hidden ? "none" : "";
    }
    host.style.display = hidden ? "none" : "";
  }

  function insertGroupBeforeHost(group, host) {
    if (!group || !host) return false;
    const displayNode = getMessageDisplayNode(host) || host;
    const parent = displayNode.parentElement || host.parentElement;
    if (!parent) return false;
    parent.insertBefore(group, displayNode);
    return true;
  }

  function clearBookmarkFilterGroups(options = {}) {
    const dropManualOpen = options.dropManualOpen !== false;
    const members = Array.from(document.querySelectorAll(`[${FILTER_GROUP_MEMBER_ATTR}="1"]`));
    for (const host of members) {
      setMessageHidden(host, false);
      host.removeAttribute(FILTER_GROUP_MEMBER_ATTR);
      host.removeAttribute(FILTER_GROUP_ID_ATTR);
    }
    const groups = Array.from(document.querySelectorAll(`[${FILTER_GROUP_ATTR}="1"]`));
    for (const group of groups) {
      group.remove();
    }
    if (dropManualOpen) {
      const manualOpen = Array.from(document.querySelectorAll(`[${FILTER_GROUP_MANUAL_OPEN_ATTR}="1"]`));
      for (const host of manualOpen) {
        host.removeAttribute(FILTER_GROUP_MANUAL_OPEN_ATTR);
      }
    }
  }

  function createBookmarkFilterGroup(hosts) {
    if (!hosts || !hosts.length) return;
    const first = hosts[0];
    if (!first) return;
    const groupId = `fg_${Date.now()}_${seq++}`;
    const rangeLabel = getGroupRangeLabel(hosts);
    const group = document.createElement("div");
    group.setAttribute(FILTER_GROUP_ATTR, "1");
    group.setAttribute(FILTER_GROUP_ID_ATTR, groupId);
    group.innerHTML = `
      <div class="mr-group-meta">篩選隱藏（${hosts.length} 則）</div>
      <div class="mr-group-title">第 ${esc(rangeLabel)} 則未命中篩選書籤類別</div>
      <div class="mr-group-actions">
        <button type="button" data-mr-action="filter-group-expand" data-mr-filter-group-id="${groupId}">展開此區段</button>
      </div>
    `;
    if (!insertGroupBeforeHost(group, first)) return;
    for (const host of hosts) {
      host.setAttribute(FILTER_GROUP_MEMBER_ATTR, "1");
      host.setAttribute(FILTER_GROUP_ID_ATTR, groupId);
      setMessageHidden(host, true);
    }
  }

  function expandBookmarkFilterGroup(groupId) {
    if (!groupId) return;
    const group = document.querySelector(`[${FILTER_GROUP_ATTR}="1"][${FILTER_GROUP_ID_ATTR}="${groupId}"]`);
    const members = Array.from(document.querySelectorAll(`[${FILTER_GROUP_MEMBER_ATTR}="1"][${FILTER_GROUP_ID_ATTR}="${groupId}"]`));
    for (const host of members) {
      setMessageHidden(host, false);
      host.removeAttribute(FILTER_GROUP_MEMBER_ATTR);
      host.removeAttribute(FILTER_GROUP_ID_ATTR);
      host.setAttribute(FILTER_GROUP_MANUAL_OPEN_ATTR, "1");
    }
    if (group) {
      group.remove();
    }
  }

  function shouldShowMessageByBookmarkFilter(messageIndex, totalMessages, host) {
    if (Number.isInteger(messageIndex) && Number.isInteger(totalMessages)) {
      const keepFrom = Math.max(1, totalMessages - KEEP_LATEST + 1);
      if (messageIndex >= keepFrom) return true;
    }
    if (host && host.getAttribute(FILTER_GROUP_MANUAL_OPEN_ATTR) === "1") return true;
    if (!isBookmarkFilterActive()) return true;
    const emojis = getBookmarkEmojis(messageIndex);
    if (!emojis.length) return false;
    for (const emoji of emojis) {
      if (bookmarkFilterSelected.has(emoji)) return true;
    }
    return false;
  }

  function applyBookmarkFilter(options = {}) {
    const resetManualOpen = options.resetManualOpen === true;
    if (resetManualOpen) {
      clearBookmarkFilterGroups({ dropManualOpen: true });
    } else {
      clearBookmarkFilterGroups({ dropManualOpen: false });
    }
    if (!isBookmarkFilterActive()) {
      if (!resetManualOpen) {
        const manualOpen = Array.from(document.querySelectorAll(`[${FILTER_GROUP_MANUAL_OPEN_ATTR}="1"]`));
        for (const host of manualOpen) {
          host.removeAttribute(FILTER_GROUP_MANUAL_OPEN_ATTR);
        }
      }
      return;
    }
    const msgs = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const total = msgs.length;
    const hiddenBucket = [];
    for (let i = 0; i < total; i += 1) {
      const host = msgs[i];
      const messageIndex = i + 1;
      if (shouldShowMessageByBookmarkFilter(messageIndex, total, host)) {
        if (hiddenBucket.length) {
          createBookmarkFilterGroup([...hiddenBucket]);
          hiddenBucket.length = 0;
        }
        setMessageHidden(host, false);
        continue;
      }
      if (host.getAttribute(FLAG) !== "1") {
        host.removeAttribute(EXPANDED_LOCK_ATTR);
        compactMessage(host, messageIndex, total);
      }
      hiddenBucket.push(host);
    }
    if (hiddenBucket.length) {
      createBookmarkFilterGroup([...hiddenBucket]);
    }
  }

  function scheduleBookmarkFilterApply(delayMs = 120, options = {}) {
    if (options.resetManualOpen) {
      bookmarkFilterResetManualPending = true;
    }
    clearTimeout(bookmarkFilterScheduled);
    bookmarkFilterScheduled = setTimeout(() => {
      bookmarkFilterScheduled = null;
      const resetManualOpen = bookmarkFilterResetManualPending;
      bookmarkFilterResetManualPending = false;
      applyBookmarkFilter({ resetManualOpen });
    }, delayMs);
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
    clearBookmarkFilterGroups({ dropManualOpen: true });
    routeKey = nextKey;
    bookmarksByIndex = loadBookmarks();
    mergeUsedEmojisIntoCatalog();
    closeBookmarkEmojiMenu();
    closeBookmarkFilterMenu();
    rerenderBookmarkDecorations();
    startupDone = false;
    showStatus("收合中", "working");
    scheduleCompact(30);
    scheduleBookmarkFilterApply(60, { resetManualOpen: true });
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
      scheduleBookmarkFilterApply(100);
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
    const emojiMenuAddBtn = e.target.closest(`[${BOOKMARK_EMOJI_ADD_ATTR}="1"]`);
    if (emojiMenuAddBtn) {
      e.preventDefault();
      e.stopPropagation();
      const input = document.getElementById(BOOKMARK_EMOJI_INPUT_ID);
      const rawValue = input ? input.value : "";
      const result = addEmojiToCatalog(rawValue);
      if (!result.ok) {
        showStatus(result.reason === "exists" ? `已存在 emoji ${result.emoji}` : "請輸入有效 emoji", "done");
        return;
      }
      if (input) input.value = "";
      showStatus(`已新增 emoji ${result.emoji}`, "done");
      return;
    }

    const filterGroupExpandBtn = e.target.closest('[data-mr-action="filter-group-expand"]');
    if (filterGroupExpandBtn) {
      e.preventDefault();
      e.stopPropagation();
      expandBookmarkFilterGroup(filterGroupExpandBtn.getAttribute("data-mr-filter-group-id"));
      return;
    }

    const filterSelectAllBtn = e.target.closest('[data-mr-action="bookmark-filter-select-all"]');
    if (filterSelectAllBtn) {
      e.preventDefault();
      e.stopPropagation();
      setBookmarkFilterAllSelected();
      return;
    }

    const filterClearBtn = e.target.closest('[data-mr-action="bookmark-filter-clear"]');
    if (filterClearBtn) {
      e.preventDefault();
      e.stopPropagation();
      setBookmarkFilterShowAll();
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
        const changed = setBookmarkEmoji(index, getDefaultBookmarkEmoji(), true);
        if (changed) {
          showStatus(`已加入預設書籤 #${index}`, "done");
        } else {
          showStatus(`#${index} 已有預設書籤`, "done");
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
        if (removeAllBookmarkEmojis(index)) {
          showStatus(`已清空 #${index} 的書籤類別`, "done");
        } else {
          showStatus(`#${index} 沒有書籤可清空`, "done");
        }
        return;
      }
      if (action === "bookmark-filter-menu") {
        const menu = document.getElementById(BOOKMARK_FILTER_MENU_ID);
        if (menu && menu.style.display !== "none") {
          closeBookmarkFilterMenu();
        } else {
          openBookmarkFilterMenu(e.target.closest('[data-mr-action="bookmark-filter-menu"]'));
        }
        return;
      }
      if (action === "bookmark-collapse-visible") {
        const result = await collapseExpandedMessagesInCurrentView();
        if (result.collapsed > 0 && result.regrouped) {
          showStatus(`已收合 ${result.collapsed} 則展開訊息，並重建篩選區段`, "done");
        } else if (result.collapsed > 0) {
          showStatus(`已收合 ${result.collapsed} 則展開訊息`, "done");
        } else if (result.regrouped) {
          showStatus("已重建篩選區段", "done");
        } else {
          showStatus("目前沒有可收合的展開訊息", "done");
        }
        return;
      }
      return;
    }

    const indexAddBtn = e.target.closest(`[${INDEX_ADD_ATTR}="1"]`);
    if (indexAddBtn) {
      e.preventDefault();
      e.stopPropagation();
      const badgeIndex = Number(indexAddBtn.getAttribute(INDEX_VALUE_ATTR));
      if (!Number.isInteger(badgeIndex) || badgeIndex <= 0) return;
      const menu = document.getElementById(BOOKMARK_EMOJI_MENU_ID);
      if (menu && menu.style.display !== "none" && Number(bookmarkMenuIndex) === badgeIndex) {
        closeBookmarkEmojiMenu();
        return;
      }
      openBookmarkEmojiMenu(indexAddBtn, badgeIndex);
      return;
    }

    const indexBadge = e.target.closest(`[${INDEX_BADGE_ATTR}="1"]`);
    if (indexBadge) {
      e.preventDefault();
      e.stopPropagation();
      const host = indexBadge.closest("[data-message-author-role]");
      const badgeIndex = Number(indexBadge.getAttribute(INDEX_VALUE_ATTR));
      if (e.shiftKey && Number.isInteger(badgeIndex) && badgeIndex > 0) {
        const added = toggleDefaultBookmark(badgeIndex);
        const emoji = getDefaultBookmarkEmoji();
        if (added === true) showStatus(`已加入 #${badgeIndex} 的 ${emoji} 類別`, "done");
        if (added === false) showStatus(`已取消 #${badgeIndex} 的 ${emoji} 類別`, "done");
        return;
      }
      focusMessageTop(host);
      return;
    }

    const clickedInsideEmojiMenu = e.target.closest(`#${BOOKMARK_EMOJI_MENU_ID}`);
    const clickedInsideFilterMenu = e.target.closest(`#${BOOKMARK_FILTER_MENU_ID}`);
    if (!clickedInsideEmojiMenu) {
      closeBookmarkEmojiMenu();
    }
    if (!clickedInsideFilterMenu) {
      closeBookmarkFilterMenu();
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
    const filterCheck = e.target.closest(`[${BOOKMARK_FILTER_CHECK_ATTR}="1"]`);
    if (filterCheck) {
      const emoji = filterCheck.getAttribute(BOOKMARK_FILTER_ITEM_ATTR) || "";
      const enabled = Boolean(filterCheck.checked);
      const normalized = normalizeEmojiTag(emoji);
      if (!normalized) return;
      if (enabled) {
        bookmarkFilterSelected.add(normalized);
      } else {
        bookmarkFilterSelected.delete(normalized);
      }
      saveBookmarkFilterSelection();
      updateBookmarkFilterButtonLabel();
      scheduleBookmarkFilterApply(40, { resetManualOpen: true });
      if (!bookmarkFilterSelected.size) {
        showStatus("篩選已清空，顯示全部訊息", "done");
      } else {
        showStatus(`篩選中：${bookmarkFilterSelected.size} 種類別`, "done");
      }
      return;
    }

    const emojiCheck = e.target.closest(`[${BOOKMARK_EMOJI_CHECK_ATTR}="1"]`);
    if (emojiCheck) {
      const index = Number(bookmarkMenuIndex);
      if (!Number.isInteger(index) || index <= 0) return;
      const emoji = emojiCheck.getAttribute(BOOKMARK_EMOJI_ITEM_ATTR) || "";
      const enabled = Boolean(emojiCheck.checked);
      const changed = setBookmarkEmoji(index, emoji, enabled);
      if (!changed) return;
      showStatus(enabled ? `#${index} 已加入 ${emoji}` : `#${index} 已取消 ${emoji}`, "done");
      renderBookmarkEmojiMenu(index);
      return;
    }

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
        scheduleBookmarkFilterApply(120, { resetManualOpen: true });
      }
      scheduleBookmarkPanelPosition();
      return;
    }

    if (wasStreaming) {
      wasStreaming = false;
      scheduleFullIndexSync(80);
      scheduleCompact(60);
      scheduleBookmarkFilterApply(100);
    }

    const messageMutated = hasMessageMutation(records);
    if (routeChanged || messageMutated) {
      processAddedMessageHosts(records);
      scheduleFullIndexSync(INDEX_SYNC_DELAY_IDLE_MS);
      scheduleBookmarkFilterApply(routeChanged ? 120 : 100, { resetManualOpen: routeChanged });
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
  bookmarkEmojiCatalog = loadEmojiCatalog();
  bookmarkFilterSelected = loadBookmarkFilterSelection();
  bookmarksByIndex = loadBookmarks();
  mergeUsedEmojisIntoCatalog();
  reconcileBookmarkFilterSelection();
  ensureBookmarkPanel();
  updateBookmarkPanelPosition();
  showStatus("收合中", "working");
  syncAllMessageIndexLabels();
  ensureButtonsForExpandedMessages();
  runCompact();
  scheduleBookmarkFilterApply(220, { resetManualOpen: true });
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    const streaming = isStreamingNow();
    if (!streaming && wasStreaming) {
      wasStreaming = false;
      scheduleFullIndexSync(80);
      scheduleCompact(60);
      scheduleBookmarkFilterApply(100);
    }
    checkRouteChange();
    updateBookmarkPanelPosition();
    if (!startupDone && !streaming) {
      runCompact();
    }
    if (!streaming) {
      scheduleBookmarkFilterApply(180);
    }
  }, PERIODIC_COMPACT_MS);
  window.addEventListener("resize", () => {
    updateBookmarkPanelPosition();
    const menu = document.getElementById(BOOKMARK_EMOJI_MENU_ID);
    if (menu && menu.style.display !== "none") {
      closeBookmarkEmojiMenu();
    }
    const filterMenu = document.getElementById(BOOKMARK_FILTER_MENU_ID);
    if (filterMenu && filterMenu.style.display !== "none") {
      closeBookmarkFilterMenu();
    }
  });
  setInterval(() => {
    flushWrites().catch((err) => console.error("[MR] periodic flush failed:", err));
  }, 2000);
})();
