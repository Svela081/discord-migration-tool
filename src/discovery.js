'use strict';

// Read Discord's visible *sidebar* only. Do not query Discord's private API.
// Category discovery is best-effort because Discord may change its markup.
const {channelId, cleanName} = require('./utils');

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{15,22}$/.test(value);
}

function normalizeCandidates(rows, serverId, categoryId) {
  const unique = new Map();
  for (const row of rows) {
    const match = channelId(row.url);
    if (!match || match.guild !== serverId || match.channel === categoryId) continue;
    if (!unique.has(match.channel)) {
      unique.set(match.channel, {
        id: match.channel,
        url: `https://discord.com/channels/${serverId}/${match.channel}`,
        folder: cleanName(row.name || `channel-${match.channel}`),
      });
    }
  }
  return [...unique.values()];
}

async function discoverCategory(page, categoryId, serverId) {
  if (!isSnowflake(categoryId) || !isSnowflake(serverId)) throw new Error('Invalid category/server ID.');
  const snapshot = await page.evaluate(({categoryId, serverId}) => {
    const matchingId = (node) => {
      const values = [node.id, node.getAttribute('data-list-item-id'), node.getAttribute('data-channel-id'), node.getAttribute('data-id')].filter(Boolean);
      return values.some(v => v === categoryId || v.endsWith('___' + categoryId) || v.endsWith('__' + categoryId));
    };
    // Avoid searching message content: only the channels nav/sidebar is relevant.
    const candidates = [...document.querySelectorAll('nav, [data-list-id="channels"], [class*="sidebar"]')];
    const navs = candidates.filter(el => el.querySelector('[data-list-item-id*="channels___"], a[href*="/channels/"]'));
    let marker = null;
    let scope = null;
    for (const nav of navs) {
      marker = [...nav.querySelectorAll('[data-list-item-id], [data-channel-id], [data-id], [id]')].find(matchingId);
      if (marker) {scope=nav;break;}
    }
    if (!marker) {
      marker = [...document.querySelectorAll('[data-list-item-id], [data-channel-id], [data-id], [id]')].find(matchingId);
      scope = marker?.closest('nav, [data-list-id="channels"], [class*="sidebar"]') || null;
    }
    if (!marker) return {found:false, categoryName:'', channels:[], reason:'Category heading not found in the visible sidebar. Expand the category and retry.'};

    const categoryName = (marker.getAttribute('aria-label') || marker.getAttribute('data-dnd-name') || marker.textContent || '')
      .replace(/^(collapse|expand)\s+/i,'').trim().slice(0, 90);
    const row = marker.closest('li, [role="listitem"]');
    if (!row) return {found:true, categoryName, channels:[], reason:'Category found, but its sidebar row could not be identified.'};

    const navRoot = scope || row.parentElement;
    const matchChannel = (element) => {
      const href = element.getAttribute('href') || '';
      const m = href.match(/^\/channels\/(\d+)\/(\d+)(?:\/)?(?:\?|$)/);
      if (!m || m[1] !== serverId) return null;
      const n = (element.querySelector('[class*="name"]')?.textContent || element.getAttribute('data-dnd-name') || element.getAttribute('aria-label') || element.textContent || '')
        .replace(/^#\s*/, '').trim().slice(0, 90);
      return {url:`https://discord.com/channels/${m[1]}/${m[2]}`,name:n};
    };
    const collect = (el) => [...el.querySelectorAll('a[href*="/channels/"]')].map(matchChannel).filter(Boolean);
    const isAnotherCategory = (el) => {
      if (el.querySelector('[class*="categoryName"], [class*="wrapperCommon"], [class*="categoryHeader"]')) return true;
      const header = el.querySelector('[aria-expanded]');
      // A category heading is a collapsible row; message threads are not in this sidebar area.
      if (header && !el.querySelector('a[href*="/channels/"]')) return true;
      return false;
    };

    let foundLinks=[];
    // Some Discord layouts nest channel links inside the same group as its heading.
    foundLinks.push(...collect(row));
    // Most layouts render category and child channel rows as siblings.
    let cursor=row.nextElementSibling;
    let seen=0;
    while (cursor && seen++ < 80) {
      if (isAnotherCategory(cursor)) break;
      foundLinks.push(...collect(cursor));
      cursor = cursor.nextElementSibling;
    }
    // Different layouts use an expanded grouping container; use that only if it
    // explicitly contains the category heading and isn't the whole sidebar.
    if (!foundLinks.length && row.parentElement && row.parentElement !== navRoot) {
      const group=row.parentElement;
      if (group.querySelectorAll('li, [role="listitem"]').length <= 55) foundLinks=collect(group);
    }
    return {found:true, categoryName, channels:foundLinks, reason:foundLinks.length ? '' : 'No child channel links found. Expand the category in Discord and retry. Voice/forum channels may not be supported.'};
  }, {categoryId,serverId});
  return {...snapshot, channels:normalizeCandidates(snapshot.channels, serverId, categoryId)};
}

// Accept channel IDs or complete channel links; derive guild from the seed link.
// This supports manual fallback without asking the user to type every channel name.
function parseChannelReferences(value, serverId) {
  if (!isSnowflake(serverId)) throw new Error('A valid server ID is required.');
  const parts = String(value || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const unique = new Set();
  for (const part of parts) {
    let id;
    if (isSnowflake(part)) id = part;
    else {
      const parsed = channelId(part);
      if (!parsed || parsed.guild !== serverId) throw new Error(`Invalid or different-server channel: ${part}`);
      id = parsed.channel;
    }
    unique.add(id);
  }
  return [...unique];
}

async function expandCategoryInSidebar(page, categoryId, categoryName='') {
  return page.evaluate(({categoryId,categoryName})=>{
    const nav=document.querySelector('[data-list-id="channels"]') || document.querySelector('nav[aria-label*="Channels"]') || document.querySelector('nav');
    if(!nav) return false;
    const elements=[...nav.querySelectorAll('[data-list-item-id], [aria-expanded], [role="button"]')];
    const key=categoryName.trim().toLowerCase();
    let match=elements.find(el=>{
      const ids=[el.id,el.getAttribute('data-list-item-id'),el.getAttribute('data-channel-id')].filter(Boolean);
      return ids.some(s=>s===categoryId||s.endsWith('___'+categoryId));
    });
    if(!match&&key) match=elements.find(el=>{
      const label=el.getAttribute('data-dnd-name')||el.getAttribute('aria-label')||el.querySelector('[class*="categoryName"]')?.textContent||el.textContent||'';
      return label.trim().toLowerCase()===key;
    });
    if(!match) return false;
    const toggler=match.matches('[aria-expanded]')?match:
      match.querySelector('[aria-expanded]')||match.closest('[aria-expanded]');
    if(toggler?.getAttribute('aria-expanded')==='false') {toggler.click();return true;}
    return false;
  },{categoryId,categoryName});
}
module.exports = {discoverCategory, isSnowflake, normalizeCandidates, parseChannelReferences, expandCategoryInSidebar};
