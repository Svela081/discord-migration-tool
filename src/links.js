'use strict';
const {looksExternalLink} = require('./utils');

// Discord can render a link twice: one as the actual anchor and once in its rich
// preview.  Mega's # fragment is the key; an anchor without it isn't a usable
// folder/file link.  Keep URLs intact, never strip/hash/redact fragments.
function normalizeExternalLink(raw, displayedText = '') {
  const candidates = [raw];
  const fromText = String(displayedText).match(/https?:\/\/[^\s<>"'“”‘’]+/gi) || [];
  candidates.push(...fromText.map(x => x.replace(/[),.;]+$/, '')));
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!looksExternalLink(u.href)) return null;
  if (/^(www\.)?mega\.nz$/i.test(u.hostname)) {
    if (/^\/rich-(?:folder|file)\.(?:png|jpg|jpeg|webp)$/i.test(u.pathname)) return null;
    if (/^\/(?:folder|file)\//i.test(u.pathname)) {
      if (!u.hash || u.hash === '#') {
        for (const candidate of candidates.slice(1)) {
          try {
            const v = new URL(candidate);
            if (v.hostname.toLowerCase() === u.hostname.toLowerCase() &&
                v.pathname === u.pathname && v.hash && v.hash !== '#') { u = v; break; }
          } catch { /* ignore displayed non-URL */ }
        }
      }
      if (!u.hash || u.hash === '#') return null;
    }
  }
  return u.href;
}

function cleanedRecords(records) {
  const seen = new Map();
  for (const record of records) {
    if (!record) continue;
    const raw = typeof record === 'string' ? record : record.url;
    const normalized = normalizeExternalLink(raw, record.label || '');
    if (!normalized || seen.has(normalized)) continue;
    seen.set(normalized, {
      messageId: typeof record.messageId === 'string' ? record.messageId : '',
      url: normalized,
      label: String(record.label || '').slice(0, 180),
    });
  }
  return [...seen.values()].sort((a,b)=>a.url.localeCompare(b.url));
}
module.exports = {normalizeExternalLink, cleanedRecords};
