# Changelog

## 1.21.0 — Generic source release and simpler setup

- One menu for category downloads, single-channel downloads, official bot imports, offline oversized reports and failed-download repair.
- Restore v1.19.2 failed-media repair in Mode 5, using original folders and separate retry scan reports.
- Return to the task menu after completion. Reuse the archive root and download Chrome session until exit.
- Load a project-local `.env` automatically; exported shell variables take precedence.
- Remember the archive root and successful destination mappings in ignored `config.json`, excluding credentials.
- Accept a destination channel URL to resolve its server and parent category. Preserve server-ID input for new categories; request an exact category ID only for ambiguous names.
- Keep v1.20.3 archive schema, reconciliation, upload journals, pending markers, hash checks and 20 MiB automatic upload cutoff.
- Replace project-specific fixtures and documentation examples with generic names. Add setup, upgrade and publishing guides, a dependency lockfile, broader archive exclusions and GitHub Actions.
- Add offline coverage for token loading, saved settings, destination selection and the task menu. Live Discord verification of this release is still pending.

# v1.20.3 — Manual oversized-file inventory and safe continuation

- **New Mode 4:** offline inventory of archived images/videos larger than the bot's configured 20 MiB cutoff. Lists files by category and channel and exports CSV and JSON into `.bot-migration-journals/`. Includes indexed categories and old loose archive folders. Never sends files or contacts Discord.
- Reads recent structure mapping reports to display last known destination channel IDs when available; do not treat this alone as proof an attachment is missing.
- Mode 3 separates oversized items from normal verified-missing items. Oversized files are never offered to the bot uploader automatically, and are itemized in the reconciliation report.
- A pending upload marker for a local file **verified larger than the cutoff** does not block otherwise safe small-file imports. Once `MIGRATE` is approved, the old marker is renamed and preserved with an `oversized-pending-...json` suffix for later review. Pending markers for other files still block automatic uploads.
- Keep strict safety checks for modified/missing journaled posts, ambiguous attachments, inaccessible history and changed destinations. An old pending marker is **not evidence that an oversized file is absent from Discord**.
- No changes to the source downloading functionality or local files. Live Discord end-to-end validation remains necessary.

# v1.20.2 — Smart Resume / media and link reconciliation (preview)

- Retains v1.20.1 official bot import and category/channel reuse/create workflow.
- Scans complete destination text channel history (maximum 100 pages × 100 messages).
- Compares local archived files to destination attachments by SHA-256, filename and byte size; recognizes renamed identical files and exact archived links.
- Reports present, missing and uncertain items in `.bot-migration-journals/reconcile-*.json` before uploads.
- Allows partial browser-migrated channels to receive only definitively missing content, after `MIGRATE` approval; previous bot journals continue to prevent duplicates.
- Blocks channels with uncertain attachment identity, missing journaled messages or unresolved pending markers. Checks history again just before posting.
- Reports unresolved source download failures; locally matched media does not prove source archive completeness.
- Keeps the 20 MiB bot upload cap, rate-limit handling and no-deletion policy unchanged.
- Adds mock/API unit tests; new reconciliation flow has not been live-tested.

# v1.20.1 — Verified bot-journal resume

- Continue safely into empty channels later in the selection (existing behavior).
- New: resume nonempty bot-uploaded channels **only if every Discord message is accounted for in its successful bot journal**.
- Skip channels with older browser-uploaded content, unjournaled messages, missing journaled messages, pending uncertain uploads or unverifiable histories.
- Preserve all current category/channel creation and upload behaviors; no deletions.
- No per-filename guesswork; large files still reported as not uploaded.


## 1.20.0 (Option A preview)
- Mode 3 now reuses uniquely matched destination categories and text channels, creating only missing structure with official bot API after `STRUCTURE` approval.
- Source-to-destination channel mapping ignores same-name channels in other categories; conflicts and channel-capacity issues fail closed.
- Adds separate optional `MIGRATE` approval and skips posting to nonempty/unverifiable destination channels by default.
- Writes a structure mapping report even when uploads are not requested.

## 1.20.0 (initial preview)
- Preserves v1.19.1 source archiving and local index.
- Category range accepts FIRST and LAST full channel URLs (inclusive) rather than last channel position/ID confirmation.
- Uses known source category ID from archive index when available; new categories still need the ID.
- Replaces inspect-only Mode 3 with an official Discord bot API archive importer.
- Mode 3 allows a user-selected number of indexed channels, exact-name matching inside destination parent category, dry preview, and explicit approval.
- Adds bot message-ID journals, uncertain-upload markers, conservative large-file reporting, and rate-limit handling.
- Prepares files for a future GitHub publication. No personal-account uploader.
