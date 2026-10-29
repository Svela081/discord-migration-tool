'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {loadJsonl} = require('./archive');
const {cleanedRecords} = require('./links');

// Discord snowflake IDs are chronological; use BigInt to prevent precision loss.
function messageSnowflake(raw) {
  const match = String(raw || '').match(/(?:^|\D)(\d{15,22})$/);
  return match ? match[1] : null;
}
function compareTimeline(a, b) {
  if (a.messageId && b.messageId) {
    const left = BigInt(a.messageId), right = BigInt(b.messageId);
    if (left !== right) return left < right ? -1 : 1;
  } else if (Boolean(a.messageId) !== Boolean(b.messageId)) {
    return a.messageId ? -1 : 1;
  }
  return a.sequence - b.sequence;
}
async function timelineFromFolder(folder) {
  const media = await loadJsonl(path.join(folder, 'download_manifest.jsonl'));
  const rawLinks = await loadJsonl(path.join(folder, 'embeds.jsonl'));
  const links = cleanedRecords(rawLinks);
  const entries = [], seen = new Set();
  let sequence = 0;
  for (const m of media) {
    if (!m.file || !m.sourcePath) continue;
    const key = 'media:' + m.sourcePath;
    if (seen.has(key)) continue;
    const absolute = path.resolve(folder, m.file);
    if (!absolute.startsWith(path.resolve(folder) + path.sep)) continue;
    try { if (!(await fs.stat(absolute)).isFile()) continue; }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    seen.add(key);
    entries.push({type:'media', key, messageId:messageSnowflake(m.messageId), file:m.file, absolute, sequence:sequence++});
  }
  for (const l of links) {
    const key = 'link:' + l.url;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({type:'link', key, messageId:messageSnowflake(l.messageId), url:l.url, sequence:sequence++});
  }
  entries.sort(compareTimeline);
  return {entries, unknownOrder:entries.filter(e=>!e.messageId).length};
}
module.exports = {messageSnowflake, compareTimeline, timelineFromFolder};
