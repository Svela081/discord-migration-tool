# Upgrading to v1.21.0

1. Finish active jobs before changing project versions. Keep the current version as a fallback.
2. Extract the new source folder separately. Do not extract it into your media archive.
3. Run `npm install`, `npm test`, then `npm start`.
4. Select your existing archive root, normally `~/Documents/Discord Migration Tool`.
5. Copy `.env.example` to `.env` in the new project folder and set `DISCORD_BOT_TOKEN` locally. Existing shell variables also work.

Keep category and loose folders, `source_archive_index.json`, download manifests, link files, `.source_channel.json` markers and `.bot-migration-journals/`. Do not delete pending markers or merge browser journals into bot journals.

The index schema remains version 1. The importer retains v1.20.3 reconciliation, size exclusions, upload journals, uncertainty checks and approval steps. Older structure reports still supply destination mappings for oversized-file reports.

## Changes in daily use

- Source downloads still accept the first and last channel URLs and reuse indexed category IDs.
- Finished tasks return to the menu with the same archive root and download browser. Choose `0` to close the tool and its browser.
- Bot tokens load automatically from `.env`, so a new Terminal window does not require re-exporting the token.
- A destination channel URL resolves the server and category. A server ID still supports creating a new category.
- A successful destination mapping is offered again next time. The structure preview still shows the exact target before changes.
- Mode `4` remains the offline oversized-file report. Mode `5` restores failed-download repair from v1.19.2.

`config.json` and `.env` belong to the project folder; archives and journals remain under the archive root. Moving to a new project folder does not move your archive. Select its existing path again.
