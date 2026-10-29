'use strict';
const {WELCOME_HEADING_PATTERN, CHANNEL_START_PATTERN} = require('./history-end');

// Browser UI DOM readers. No Discord private API endpoints or user-token extraction.
// Discord changes its markup frequently; see README troubleshooting section.
async function channelNameFromPage(page, id) {
  return await page.evaluate((channelId) => {
    const link = Array.from(document.querySelectorAll('a[href]'))
      .find(a => a.getAttribute('href')?.split('?')[0].endsWith('/' + channelId));
    const text = link?.querySelector('[class*="name"]')?.textContent || link?.textContent;
    const header = document.querySelector('main header h1, main header [class*="title"], header h1');
    return (text || header?.textContent || '').trim().replace(/^#\s*/, '').slice(0, 90);
  }, id);
}

async function captureVisible(page) {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      'li[id^="chat-messages-"], li[data-list-item-id^="chat-messages"], div[id^="chat-messages-"]'
    ));
    // A message may match multiple selectors, or the matched wrapper may contain another.
    const unique = Array.from(new Set(nodes)).filter(n => !nodes.some(other => other !== n && n.contains(other)));
    const messages = [];
    const validUrl = (raw) => { try { return new URL(raw, document.baseURI).href; } catch { return ''; } };
    for (const node of unique) {
      const id = node.id || node.getAttribute('data-list-item-id') || '';
      const media = new Map();
      const links = new Map();
      const addMedia = (raw, label='') => {
        const url = validUrl(raw);
        if (url.startsWith('https:')) media.set(url, {url, name: label});
      };
      for (const anchor of node.querySelectorAll('a[href]')) {
        const href = validUrl(anchor.href);
        const label = (anchor.getAttribute('download') || anchor.textContent || anchor.getAttribute('aria-label') || '').trim().slice(0, 160);
        if (href && /^https:/.test(href)) {
          const u = new URL(href);
          if (['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) &&
              /^\/(?:attachments|ephemeral-attachments)\//i.test(u.pathname)) {
            addMedia(href, label);
          } else if (!/(?:^|\.)discord(?:app)?\.(?:com|net)$/.test(u.hostname) &&
                     !u.hostname.endsWith('.discord.com')) {
            // Prefer a full visible Mega URL when Discord's preview href loses #key.
            let full = href;
            if (/^(?:www\.)?mega\.nz$/i.test(u.hostname) && !u.hash) {
              const matches = label.match(/https?:\/\/[^\s<>\"']+/g) || [];
              for (const candidate of matches) {
                try {
                  const c = new URL(candidate.replace(/[),.;]+$/, ''));
                  if (c.hostname === u.hostname && c.pathname === u.pathname && c.hash) {full = c.href; break;}
                } catch { /* preview text isn't necessarily a URL */ }
              }
            }
            links.set(full, {url: full, text: label});
          }
        }
      }
      for (const elem of node.querySelectorAll('img,video,video source')) {
        const tag = elem.tagName.toLowerCase();
        const url = validUrl(elem.currentSrc || elem.src || elem.getAttribute('src'));
        if (!url) continue;
        const elUrl = new URL(url);
        // Only media attached to Discord messages, not avatars, server icons, or emoji.
        if (['cdn.discordapp.com','media.discordapp.net'].includes(elUrl.hostname) &&
            /^\/(?:attachments|ephemeral-attachments)\//i.test(elUrl.pathname)) {
          const enclosing = elem.closest('a[href]');
          const full = enclosing && validUrl(enclosing.href);
          if (full && /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/(?:attachments|ephemeral-attachments)\//i.test(full)) {
            addMedia(full, elem.alt || '');
          } else if (tag !== 'video' || !url.startsWith('blob:')) {
            addMedia(url, elem.alt || '');
          }
        }
        if (tag === 'video') {
          // Poster frames should not replace video attachments; source / anchor preferred.
          const src = validUrl(elem.src || elem.querySelector('source')?.src);
          if (src?.startsWith('https:')) addMedia(src);
        }
      }
      // Some media cards put the original attachment URL in attributes rather than href.
      for (const elem of node.querySelectorAll('[data-safe-src], [data-src]')) {
        const raw = elem.getAttribute('data-safe-src') || elem.getAttribute('data-src');
        const url = validUrl(raw);
        if (url && /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/(?:attachments|ephemeral-attachments)\//i.test(url)) addMedia(url);
      }
      if (media.size || links.size) messages.push({id, media: [...media.values()], links: [...links.values()]});
      else messages.push({id, media: [], links: []});
    }
    return messages;
  });
}

async function moveToBottom(page) {
  return page.evaluate(() => {
    const msg = document.querySelector('[data-list-id="chat-messages"]') ||
      document.querySelector('[id^="chat-messages-"], [data-list-item-id^="chat-messages"]');
    const choices = [];
    let current = msg;
    while (current && current !== document.body) { choices.push(current); current = current.parentElement; }
    const find = choices.find(el => el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 100 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    const fallback = Array.from(document.querySelectorAll('[class*="scroller"]'))
      .filter(el => el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 100 &&
        (el.querySelector('[id^="chat-messages-"]') || el.querySelector('[data-list-id="chat-messages"]')))[0];
    const target = find || fallback;
    if (!target) return false;
    // Only jump when Discord restored a prior position; it normally starts at bottom.
    if (target.scrollHeight - target.clientHeight - target.scrollTop > 12) {
      target.scrollTop = target.scrollHeight;
    }
    return true;
  });
}

async function scrollOlder(page) {
  return page.evaluate(() => {
    const msg = document.querySelector('[data-list-id="chat-messages"]') ||
      document.querySelector('[id^="chat-messages-"], [data-list-item-id^="chat-messages"]');
    let current = msg;
    const choices = [];
    while (current && current !== document.body) { choices.push(current); current = current.parentElement; }
    let target = choices.find(el => el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 100 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    if (!target) target = Array.from(document.querySelectorAll('[class*="scroller"]'))
      .find(el => el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 100 &&
        (el.querySelector('[id^="chat-messages-"]') || el.querySelector('[data-list-id="chat-messages"]')));
    if (!target) target = choices.find(el => el.clientHeight > 100 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    if (!target) return {found: false, top: false, before: 0, after: 0};
    const before = target.scrollTop;
    target.scrollTop = Math.max(0, before - Math.max(180, Math.floor(target.clientHeight * 0.65)));
    return {found: true, top: target.scrollTop <= 6, before, after: target.scrollTop};
  });
}

// Read the scroll position after async DOM updates have settled. Discord may
// prepend older messages and shift scrollTop after a scroll has reached zero.
async function readScrollState(page) {
  return page.evaluate(({welcomeHeadingPattern, channelStartPattern}) => {
    const msg = document.querySelector('[data-list-id="chat-messages"]') ||
      document.querySelector('[id^="chat-messages-"], [data-list-item-id^="chat-messages"]');
    if (!msg) return {found:false, top:false, position:null};
    let current = msg;
    const ancestors = [];
    while (current && current !== document.body) {
      ancestors.push(current);
      current = current.parentElement;
    }
    let target = ancestors.find(el => el.clientHeight > 100 &&
      el.scrollHeight > el.clientHeight + 80 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    if (!target) target = ancestors.find(el => el.clientHeight > 100 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    if (!target) target = Array.from(document.querySelectorAll('[class*="scroller"]'))
      .find(el => el.clientHeight > 100 &&
        (el.querySelector('[id^="chat-messages-"]') || el.querySelector('[data-list-id="chat-messages"]')));
    if (!target) return {found:false, top:false, position:null, welcomeVisible:false};

    // Discord displays a channel introduction at the beginning of many text
    // channels: heading 'Welcome to #name' and description 'This is the start
    // of ...'. Require both, a visible heading inside the MESSAGE scroller,
    // and a nearby common ancestor. Ignore quoted/user-authored message text.
    // Other channel types, locales, and UI releases may lack this banner.
    const headingRe = new RegExp(welcomeHeadingPattern, 'i');
    const descriptionRe = new RegExp(channelStartPattern, 'i');
    const paneBounds = target.getBoundingClientRect();
    let welcomeVisible = false;
    const headings = target.querySelectorAll('h1, h2, h3, [role="heading"]');
    for (const heading of headings) {
      if (!headingRe.test((heading.textContent || '').trim())) continue;
      const headingBounds = heading.getBoundingClientRect();
      if (headingBounds.width <= 0 || headingBounds.height <= 0 ||
          headingBounds.bottom < paneBounds.top || headingBounds.top > paneBounds.bottom) continue;
      if (heading.closest('li[id^="chat-messages-"], li[data-list-item-id^="chat-messages"], div[id^="chat-messages-"]')) continue;
      // Keep the description scoped to a small intro block, not the whole chat
      // viewport, so an unrelated message cannot accidentally satisfy it.
      let ancestor = heading.parentElement;
      for (let depth = 0; ancestor && ancestor !== target && depth < 6; depth++, ancestor = ancestor.parentElement) {
        const text = ancestor.innerText || ancestor.textContent || '';
        if (text.length > 1500) break;
        if (descriptionRe.test(text)) {
          welcomeVisible = true;
          break;
        }
      }
      if (welcomeVisible) break;
    }

    return {found:true, top:target.scrollTop <= 6, position:target.scrollTop,
      scrollHeight:target.scrollHeight, clientHeight:target.clientHeight,
      welcomeVisible};
  }, {welcomeHeadingPattern: WELCOME_HEADING_PATTERN, channelStartPattern: CHANNEL_START_PATTERN});
}

module.exports = {channelNameFromPage, captureVisible, moveToBottom, scrollOlder, readScrollState};
