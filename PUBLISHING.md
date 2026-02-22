# Publishing Workflow

Goal: maintain directly on GitHub and install with one-click GitHub Raw URL.

## Install URL

- `https://raw.githubusercontent.com/allenyllee/ChatGPT-Browser-Memory-Reducer/main/chatgpt-browser-memory-reducer.user.js`

## Release Steps

1. Update `chatgpt-browser-memory-reducer.user.js`.
2. Bump `@version` in script header.
3. Keep `@downloadURL` and `@updateURL` pointing to the GitHub Raw URL.
4. Commit and push to `main`.
5. Verify update from the Raw URL in Tampermonkey / Violentmonkey.

## Metadata Checklist

- `@name`
- `@version`
- `@license`
- `@downloadURL` (GitHub Raw)
- `@updateURL` (GitHub Raw)
- `@match`
