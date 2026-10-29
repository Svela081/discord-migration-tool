'use strict';
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.jfif', '.bmp', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv', '.mpeg', '.mpg']);
const MEDIA_DOMAINS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']);

function expandHome(input) {
  return input === '~' ? os.homedir() : input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : path.resolve(input);
}
function cleanName(raw, fallback='unnamed') {
  let str = String(raw || '').normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return str.slice(0, 90) || fallback;
}
function channelId(url) {
  try {
    const u = new URL(url);
    if (!['discord.com', 'www.discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(u.hostname)) return null;
    const match = u.pathname.match(/^\/channels\/(\d+)\/(\d+)\/?$/);
    return match ? { guild: match[1], channel: match[2] } : null;
  } catch { return null; }
}
function validMediaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && MEDIA_DOMAINS.has(u.hostname) &&
      (/^\/(?:attachments|ephemeral-attachments)\//i.test(u.pathname));
  } catch { return false; }
}
function mediaKind(url) {
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    const ext = path.posix.extname(p).toLowerCase();
    if (IMAGE_EXT.has(ext)) return 'Images';
    if (VIDEO_EXT.has(ext)) return 'Videos';
  } catch { /* unknown */ }
  return null;
}
function kindFromContentType(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'Images';
  if (m.startsWith('video/')) return 'Videos';
  return null;
}
function extFromContentType(mime) {
  const m = String(mime || '').split(';')[0].toLowerCase();
  return ({'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','image/avif':'.avif','image/heic':'.heic',
    'video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','video/x-matroska':'.mkv'})[m] || '';
}
function mediaKey(url) {
  // CDN query params contain time-limited signatures; don't store them in manifests.
  const u = new URL(url);
  return `${u.pathname}`;
}
function nameFromUrl(url) {
  const u = new URL(url);
  try { return cleanName(decodeURIComponent(u.pathname.split('/').at(-1)), 'attachment'); }
  catch { return 'attachment'; }
}
function shortHash(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 10); }
function looksExternalLink(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (MEDIA_DOMAINS.has(u.hostname)) return false;
    if (/^(discord\.com|www\.discord\.com|discordapp\.com)$/.test(u.hostname)) return false;
    if (u.hostname.endsWith('.discord.com')) return false;
    return true;
  } catch { return false; }
}
function outputFolder(root, channel) {
  const base = expandHome(root);
  const category = channel.category ? cleanName(channel.category) : '';
  const folder = cleanName(channel.folder || `channel-${channelId(channel.url)?.channel ?? 'unknown'}`);
  const resolved = path.resolve(base, ...(category ? [category] : []), folder);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Unsafe archive destination');
  return resolved;
}
module.exports = {expandHome, cleanName, channelId, validMediaUrl, mediaKind, kindFromContentType, extFromContentType, mediaKey, nameFromUrl, shortHash, looksExternalLink, outputFolder};
