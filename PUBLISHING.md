# Publishing Workflow

Goal: keep installation simple via Gist Raw, and keep docs/source in this GitHub repo.

## Recommended Structure

1. Keep `chatgpt-browser-memory-reducer.user.js` as the only file in the public install Gist.
2. Keep README/license/changelog/development files in this repo.
3. In the userscript header, keep `@downloadURL` and `@updateURL` pointing to the Gist Raw URL.

## Release Steps

1. Update code in this repo.
2. Bump `@version` in `chatgpt-browser-memory-reducer.user.js`.
3. Commit and push repo changes.
4. Copy the updated script content to the single-file install Gist.
5. Verify install/update in Tampermonkey or Violentmonkey by opening the Gist Raw URL.

## Metadata Checklist

- `@name`
- `@version`
- `@license`
- `@downloadURL` (Gist Raw)
- `@updateURL` (Gist Raw)
- `@match`

## Notes

- Gist file order cannot be pinned; single-file Gist avoids that issue.
- If you need multiple scripts, create one install Gist per script.
