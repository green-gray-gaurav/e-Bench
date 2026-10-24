# Verification

Checks use temporary databases, not a reader's notebook data.

## Automated checks

- `npm run check`: syntax checks for backend and frontend modules.
- `npm test`: 14 tests covering claims, lease expiry, stale-token rejection, duplicate submissions, cancellation/retry, note ordering, persistence, note deduplication, PDF validation, and actual HTTP/MCP transport.
- Worker lifecycle tests include aborting a real HTTP wait, ignoring stale persisted wait deadlines, respecting notebook scope, and clearing live-request state.
- Visual tests cover PNG decoding and limits, invalid/stale claims, file paths, file URLs, base64, legacy-tool submission, duplicate-safe attachment, Notes, and discovery of files created during the current claim.
- `npm run build`: Vite production build with bundled PDF.js support assets and fonts.

## Browser checks

Chromium checks during development covered desktop/mobile layouts, notebook navigation, the shared Reader/Notes header, PDF click-to-collapse behavior, note editing, failed-save draft retention, retry, append/delete, green appended text, chart enlargement, image display, and image preservation during note edits.

The Connect Codex configuration and startup-message copy controls were checked. Question status changes were checked for disconnected, listening, processing, and interrupted states.

Screenshots, logs, PDFs, notebook databases, and generated images remain local and are excluded from Git.

## Practical limits

- Most image transport checks use a small PNG fixture. A real generated PNG was also recovered and submitted through the compatibility path, then read back from the image endpoint.
- Generation depends on the connected host's tools and permissions. This does not guarantee every Codex session has image generation or will continue listening indefinitely.
- Docker Compose configuration was validated during development; container startup was not verified here.
- The product is a local single-user prototype, not an authenticated multi-user service.
