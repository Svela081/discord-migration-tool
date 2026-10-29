'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {
  validMediaUrl, mediaKind, kindFromContentType, extFromContentType, mediaKey,
  nameFromUrl, shortHash, cleanName,
} = require('./utils');
const {normalizeExternalLink, cleanedRecords} = require('./links');

async function loadJsonl(file) {
  try {
    const content = await fsp.readFile(file, 'utf8');
    return content.trim().split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
function filenameFor(url, messageId, kind, contentType) {
  const raw = nameFromUrl(url);
  const ext = path.extname(raw);
  const proposed = !ext ? raw + extFromContentType(contentType) : raw;
  return cleanName(proposed, kind === 'Images' ? 'image' : 'video');
}
async function chooseDestination(folder, filename, key) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(folder, filename);
  try {
    await fsp.access(candidate);
    candidate = path.join(folder, cleanName(stem).slice(0, 70) + '__' + shortHash(key) + ext);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return candidate;
}

async function downloadMedia(url, directory, maxFileMB, messageId) {
  if (!validMediaUrl(url)) throw new Error('Refusing non-Discord media URL');
  const maxBytes = Math.max(1, maxFileMB) * 1024 * 1024;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30 * 60_000),
    headers: {'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) DiscordMigrationTool/1.0'}
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} (link may have expired)`);
  if (!validMediaUrl(response.url)) throw new Error('Refusing unexpected redirect destination');
  const mime = response.headers.get('content-type') || '';
  const kind = kindFromContentType(mime) || mediaKind(url);
  if (!kind) throw new Error(`Not an image/video attachment (Content-Type: ${mime || 'unknown'})`);
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > maxBytes) throw new Error(`File exceeds configured max size (${maxFileMB} MB)`);
  const destFolder = path.join(directory, kind);
  await fsp.mkdir(destFolder, {recursive: true});
  const key = mediaKey(url);
  const filename = filenameFor(url, messageId, kind, mime);
  const destination = await chooseDestination(destFolder, filename, key);
  const temp = destination + `.part-${process.pid}-${shortHash(url).slice(0, 6)}`;
  let downloaded = 0;
  const limiter = new Transform({transform(chunk, encoding, callback) {
    downloaded += chunk.length;
    callback(downloaded > maxBytes ? new Error(`Exceeded configured max size (${maxFileMB} MB)`) : null, chunk);
  }});
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(temp, {flags:'wx'}));
    // Never overwrite an existing media file, even when downloads finish concurrently.
    let selected = destination;
    for (let attempt=0; attempt<30; attempt++) {
      try { await fsp.copyFile(temp, selected, fs.constants.COPYFILE_EXCL); break; }
      catch (e) {
        if (e.code !== 'EEXIST' || attempt === 29) throw e;
        const ext = path.extname(filename);
        const stem = path.basename(filename, ext);
        selected = path.join(destFolder, cleanName(stem).slice(0, 65) + '__' + shortHash(key) + (attempt ? `_${attempt}` : '') + ext);
      }
    }
    await fsp.rm(temp, {force:true});
    return {messageId, sourcePath: new URL(url).pathname, file: path.relative(directory, selected), bytes: downloaded, kind, savedAt: new Date().toISOString()};
  } catch (error) {
    await fsp.rm(temp, {force:true}).catch(() => {});
    throw error;
  }
}

class ChannelArchive {
  constructor(directory, maxFileMB = 1024, retryOnlyPaths = null) {
    this.directory = directory;
    this.maxFileMB = maxFileMB;
    this.retryOnlyPaths = retryOnlyPaths ? new Set(retryOnlyPaths) : null;
    this.completed = new Set();
    this.attempted = new Set();
    this.links = new Map();
    this.stats = {saved:0, skipped:0, failed:0, links:0};
  }
  async init() {
    await fsp.mkdir(this.directory, {recursive:true});
    const rows = await loadJsonl(path.join(this.directory, 'download_manifest.jsonl'));
    for (const row of rows) if (row.sourcePath) this.completed.add(row.sourcePath);
    const previousLinks = await loadJsonl(path.join(this.directory, 'embeds.jsonl'));
    for (const link of cleanedRecords(previousLinks)) this.links.set(link.url, link);
  }
  async process(messages) {
    const jobs = [];
    for (const message of messages) {
      for (const media of message.media) {
        if (!validMediaUrl(media.url)) continue;
        const key = mediaKey(media.url);
        if (this.retryOnlyPaths && !this.retryOnlyPaths.has(key)) continue;
        if (this.completed.has(key) || this.attempted.has(key)) continue;
        this.attempted.add(key);
        jobs.push({url: media.url, id: message.id});
      }
      for (const link of message.links) {
        const normalized = normalizeExternalLink(link.url, link.text);
        if (!normalized || this.links.has(normalized)) continue;
        const record = {messageId: message.id, url: normalized, label: String(link.text || '').slice(0, 180)};
        this.links.set(normalized, record);
        await fsp.appendFile(path.join(this.directory, 'embeds.jsonl'), JSON.stringify(record) + '\n');
        this.stats.links++;
      }
    }
    // Small batches limit both rate and memory; download while the signed URLs are fresh.
    const concurrency = 1;
    for (let start=0; start<jobs.length; start+=concurrency) {
      await Promise.all(jobs.slice(start, start+concurrency).map(async job => {
        try {
          const result = await downloadMedia(job.url, this.directory, this.maxFileMB, job.id);
          await fsp.appendFile(path.join(this.directory, 'download_manifest.jsonl'), JSON.stringify(result) + '\n');
          this.completed.add(result.sourcePath);
          this.stats.saved++;
          process.stdout.write(`  ✓ ${result.file} (${(result.bytes / 1048576).toFixed(1)} MB)\n`);
        } catch (error) {
          this.stats.failed++;
          await fsp.appendFile(path.join(this.directory, 'errors.jsonl'), JSON.stringify({messageId:job.id, sourcePath:new URL(job.url).pathname, error:error.message, at:new Date().toISOString()}) + '\n');
          process.stdout.write(`  ! ${new URL(job.url).pathname.split('/').at(-1)}: ${error.message}\n`);
        }
      }));
    }
    this.stats.skipped += messages.reduce((n,m) => n + m.media.filter(x => validMediaUrl(x.url) && this.completed.has(mediaKey(x.url))).length, 0);
  }
  async finish(info, reportFile = 'scan_report.json') {
    const records = cleanedRecords([...this.links.values()]);
    this.links = new Map(records.map(link => [link.url, link]));
    const allLinks = records.map(x => x.url);
    await fsp.writeFile(path.join(this.directory, 'embeds.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    await fsp.writeFile(path.join(this.directory, 'embeds.txt'), allLinks.join('\n') + (allLinks.length ? '\n' : ''));
    await fsp.writeFile(path.join(this.directory, reportFile), JSON.stringify({...info, ...this.stats, totalManifestFiles: this.completed.size, totalSavedLinks: this.links.size}, null, 2) + '\n');
  }
}
module.exports = {ChannelArchive, downloadMedia, loadJsonl};
