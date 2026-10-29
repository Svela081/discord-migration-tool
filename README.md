# Discord Migration Tool

A local command-line tool for archiving Discord images, videos and external links, repairing failed downloads, and importing saved archives with an official Discord bot.

Download first, review your local archive, then import it into a destination server. The tool reuses matching destination categories and text channels and creates only what is missing.

## Quick start

Requires **Node.js 20.12+** and, for source downloads, **Google Chrome**. The browser workflow was developed on macOS; other operating systems have not been verified.

```bash
npm install
npm test
npm start
```

```text
1 — Download a source category range
2 — Download one source channel
3 — Import saved archives with an official bot
4 — Export oversized-file report (offline)
5 — Repair failed image/video downloads
0 — Exit
```

The archive root defaults to `~/Documents/Discord Migration Tool`. The tool remembers your chosen folder in local `config.json` and asks for it once per session. Finished tasks return to the menu. The download browser stays open between tasks until you exit.

**Upgrading:** extract this version into a separate project folder and select your existing archive root. Keep the archive index, manifests, links and upload journals together. See [Upgrading](docs/UPGRADING.md).

## 1. Download a category range

Choose **1** and paste the first and last source channel URLs, inclusive. For a new source category, provide its category ID; an already indexed category reuses that ID. Review the discovered channel names and archive folder, then type `DOWNLOAD`.

The tool opens a dedicated Chrome profile. Sign in through Chrome if needed. It starts at recent messages and scans toward the channel beginning, saving files under their category and channel names. Completed downloads are skipped on reruns.

The sidebar preview can include adjacent categories. Check both endpoints before approving. A browser scan is best-effort: reaching the welcome banner or a stable oldest boundary does not prove every original attachment is available.

Choose **2** to archive one channel. Single-channel archives remain standalone and do not automatically enter the indexed category importer.

## 2. Repair failed downloads

Choose **5** to scan category folders and older loose folders for unresolved `errors.jsonl` entries. Select how many affected channels to revisit and type `RETRY`.

The scanner obtains fresh attachment links from the source channels and requests only media paths with unresolved failures. Recovered files return to their original folders. Old error logs and original scan reports remain available, and successful recoveries are appended to the download manifest. Retry scans use `retry_scan_report.json`, and the summary is saved in `.archive-reports/`.

An empty folder without a usable source URL or error record cannot be repaired automatically. Deleted or inaccessible attachments may remain unresolved.

## 3. Import with an official bot

Create and install a bot in the destination server using the [bot setup guide](docs/BOT_SETUP.md). Copy `.env.example` to `.env`, then set your token locally:

```dotenv
DISCORD_BOT_TOKEN=replace_with_your_bot_token
```

The CLI loads `.env` automatically. An exported shell token takes precedence. The token is not written into reports or saved settings. Never commit a populated `.env`.

Choose **3**, select an indexed source category, a starting channel number, and how many channels to prepare. Then choose the destination:

- **Paste a full destination channel URL** to identify its server and parent category automatically. Any accessible text channel in that category works; no dedicated anchor is needed. A full category URL also works.
- **Enter a destination server ID** to choose a category by name or create a missing category. An exact category ID is requested only for ambiguous names.

The last successful destination is offered next time for that source category. You can replace it at the prompt.

Review `REUSE` / `CREATE`, then type `STRUCTURE` to create only missing categories and text channels. The tool then compares destination history with your local archive:

| Result | Meaning |
| --- | --- |
| Present | Matching media verified by size and SHA-256, or an exact archived standalone link |
| Missing | Local item eligible for import after verification |
| Uncertain / blocked | Ambiguous match, inaccessible history, conflicting journal or unresolved upload outcome |
| Oversized | Above the tool's 20 MiB automatic upload cutoff; requires manual review |

Type `MIGRATE` to post verified missing items from eligible channels. Press Enter to finish without uploading. `STRUCTURE` and `MIGRATE` are separate approvals, once per selected batch.

Successful posts are journaled. The importer checks history again before each eligible channel and blocks it if the destination changed after the preview. Existing content is not deleted or overwritten. Ordinary unresolved pending markers remain blocking; a marker for a file verified above the size cutoff is preserved separately when upload is approved.

## 4. Oversized-file report

Choose **4** for an offline CSV and JSON inventory of actual files larger than **20 MiB**. No Chrome session, Discord connection or token is needed. Reports cover indexed categories, older loose archives and saved destination mappings when available.

Reports are written to `.bot-migration-journals/manual-oversized-*.csv` and `.json`. These files are **not confirmed missing from Discord**. Check the destination before uploading manually. Personal Nitro allowances do not change the tool's bot cutoff.

## Local files and compatibility

```text
Discord Migration Tool/
  source_archive_index.json
  .archive-reports/
  .bot-migration-journals/
  Sample Archive/
    photos/
      Images/
      Videos/
      download_manifest.jsonl
      errors.jsonl
      embeds.jsonl
      embeds.txt
      scan_report.json
      .source_channel.json
```

Project-local `.env` holds the token. `config.json` holds the archive root and destination choices. Both are excluded from Git. Optionally copy `config.example.json` to `config.json` before the first run.

The archive format and journals remain compatible with v1.20.3. Loose legacy folders are never automatically moved. Browser upload journals are not merged into bot journals; reconciliation compares actual destination content instead.

## Scope and limits

- Saves images, videos and recognized external links. It does not reproduce arbitrary text, original authors, threads, roles, permission overrides or backdated timestamps.
- Only indexed category archives appear in the bot importer. “Locally complete” means the destination matches the local archive, not every original source message. Oversized items are reported separately.
- A destination category can hold up to 50 channels. History verification stops at 10,000 messages per channel and blocks import when full accessible history cannot be verified within that bound.
- Hash checks download candidate destination attachments and may take time. Unreadable attachments, ambiguous matches and changed destinations require review. Modified encodings may not match original media.
- Use one downloader per dedicated Chrome profile. Avoid simultaneous imports into the same channels or writes to the same archive folders.
- Source browser automation is separate from the official bot API and is subject to Discord's account-automation restrictions. Stop if challenged. See [Security and privacy](SECURITY.md).

## Development and publication

```bash
npm test
npm run check
node index.js --help
node index.js --version
```

Tests use temporary archives and mocked Discord API responses. All 104 tests pass; live Discord verification remains separate. See [Validation](docs/VALIDATION.md).

See [Publishing](docs/PUBLISHING.md) and [Changelog](CHANGELOG.md). No open-source license has been selected; package metadata uses `UNLICENSED`. Add a license you choose before offering reuse rights.
