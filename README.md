# ChatGPT Browser Memory Reducer

One-click install:

- https://raw.githubusercontent.com/allenyllee/ChatGPT-Browser-Memory-Reducer/main/chatgpt-browser-memory-reducer.user.js

Chinese version: [`README.zh.md`](README.zh.md)

`chatgpt-browser-memory-reducer.user.js` is a userscript for Tampermonkey / Violentmonkey that reduces browser memory usage and UI lag in long ChatGPT conversations.

It compacts older messages into preview cards, stores full content in IndexedDB for on-demand restore, and adds message indexing, emoji bookmarks, and bookmark-based filtering.

## Features

- Automatically compacts older messages while keeping the latest `10` visible (configurable).
- Compact cards show role + preview; click **Expand** to restore full content.
- Full snapshots are stored in IndexedDB instead of staying only in live DOM memory.
- Sticky index badge on each message (for example `35/120`) for fast navigation.
- `Shift + Click` on an index badge toggles the default emoji bookmark for that message.
- `+` next to the index opens per-message emoji bookmark management (multi-select).
- Floating bookmark panel supports:
  - jump by message number
  - jump via bookmarked index dropdown
  - collapse visible expanded messages
  - filter by bookmark categories
  - export bookmarks as JSON for all conversation routes
- When bookmark filtering is active, only selected bookmark categories + latest 10 messages stay visible.
- Consecutive hidden ranges are grouped into expandable placeholders.

## Installation

## 1) Install a userscript manager

Use one of the following:

- Tampermonkey
- Violentmonkey

## 2) Install the script

Import `chatgpt-browser-memory-reducer.user.js` into your userscript manager, or install via the script `@downloadURL`.

## 3) Open ChatGPT

Supported matches:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

The script starts automatically on conversation pages.

## Usage

- Older messages compact automatically; click **Expand** on a compact card to restore.
- Expanded messages include an inline **Collapse this message** button.
- In the bottom-right panel:
  - Enter a number to jump to that message (Enter to confirm; mouse wheel increments/decrements).
  - Use the bookmark dropdown to jump to bookmarked messages.
  - Use **Filter** to show specific emoji bookmark categories.
  - Use **Export all** to download bookmarks for all routes as JSON.
- Index badge actions:
  - Click: scroll to that message.
  - `Shift + Click`: toggle default bookmark emoji.
  - Click `+`: open emoji bookmark picker for that message.

## Data Storage & Privacy

This script stores data locally in your browser only; it does not upload message content to external servers.

- IndexedDB
  - DB: `chatgpt-browser-memory-reducer`
  - Store: `messages`
  - Purpose: full HTML snapshots for compacted messages
- localStorage
  - `mr-bookmarks:<route>`: per-route bookmarks
  - `mr-bookmark-emoji-catalog:v1`: emoji category catalog
  - `mr-bookmark-filter-selection:v1`: selected filter categories

`<route>` is a canonical route key. For conversation pages it uses `c:<conversationId>` (from `/c/<id>`), so query-string changes do not split bookmark sets.
Legacy bookmark keys are no longer supported.

## Tunable Constants (Advanced)

Edit constants at the top of the script:

- `KEEP_LATEST = 10`: newest messages kept un-compacted
- `PREVIEW_CHARS = 320`: preview length for compact cards
- `MAX_COMPACT_PER_RUN = 10`: max messages compacted per cycle
- `PERIODIC_COMPACT_MS = 1500`: periodic scheduling interval
- `HOT_CACHE_LIMIT = 8`: in-memory hot cache size

## Known Limitations

- Depends on ChatGPT DOM structure; frontend changes may require script updates.
- Expanded content is restored from DOM snapshots captured at compact time.
- Clearing site data removes bookmarks and stored snapshots.

## Troubleshooting

- If panel/index badges do not appear: refresh and verify the script is enabled on the target domain.
- If restore/expand behaves unexpectedly:
  - refresh first
  - then clear this site’s IndexedDB/localStorage and retry
- If another userscript conflicts, disable others and test in isolation.

## License

This project is licensed under the MIT License. See `LICENSE`.
