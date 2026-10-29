'use strict';

// Discover a long category by scrolling only Discord's CHANNEL SIDEBAR.
// Discord may virtualize the list; a one-time DOM snapshot can omit many rows.
// No Discord internal API calls, account tokens, or request spoofing.
const {normalizeCandidates, isSnowflake} = require('./discovery');

const MAX_SIDEBAR_STEPS = 240;

function combineCandidates(previous, additions, serverId, categoryId) {
  const result = new Map((previous || []).map(ch => [ch.id, ch]));
  for (const item of normalizeCandidates(additions || [], serverId, categoryId)) {
    const old = result.get(item.id);
    // Prefer a real channel name over a numeric placeholder.
    if (!old || (!/^channel-\d+$/.test(item.folder) && /^channel-\d+$/.test(old.folder))) {
      result.set(item.id, item);
    }
  }
  return [...result.values()];
}

function mergeSidebarSnapshot(state, snapshot) {
  const entries = (snapshot?.entries || []);
  for (const item of entries) {
    if (state.finished) break;
    if (item.type === 'category') {
      if (item.id === state.categoryId) state.started = true;
      else if (state.started) {
        state.finished = true;
        state.reason = 'next-category-heading';
      }
    } else if (item.type === 'channel' && state.started) {
      state.channels = combineCandidates(state.channels, [item], state.serverId, state.categoryId);
    }
  }
  if (state.started && !state.finished && snapshot?.atEnd) {
    state.finished = true;
    state.reason = 'sidebar-bottom';
  }
  return state;
}

async function sidebarSnapshot(page, {serverId, categoryId, categoryName}) {
  return page.evaluate(({serverId, categoryId, categoryName}) => {
    const channelList = document.querySelector('[data-list-id="channels"]') ||
      document.querySelector('nav[aria-label*="Channel"]') ||
      [...document.querySelectorAll('nav, [class*="sidebar"]')]
        .find(el => el.querySelector('a[href*="/channels/"]'));
    if (!channelList) return {available:false, entries:[], reason:'channel-sidebar-not-found'};

    const isScrollable = el => el && el.clientHeight > 90 && el.scrollHeight > el.clientHeight + 12 &&
      /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    // Discord's list may have a scrolling ancestor or a descendant scroller.
    let scroller = channelList;
    while (scroller && !isScrollable(scroller)) scroller = scroller.parentElement;
    if (!scroller) {
      scroller = [channelList, ...channelList.querySelectorAll('[class*="scroller"], [role="presentation"]')]
        .find(isScrollable) || null;
    }
    if (!scroller) return {available:false, entries:[], reason:'channel-sidebar-scroller-not-found'};

    const viewport = scroller.getBoundingClientRect();
    const visible = el => {
      const b = el.getBoundingClientRect();
      return b.height > 0 && b.width > 0 &&
        b.bottom > viewport.top + 2 && b.top < viewport.bottom - 2 &&
        b.right > viewport.left && b.left < viewport.right;
    };
    const entries=[];
    const categoryText = n => String(n?.textContent || n?.getAttribute('aria-label') || '').trim().replace(/^(?:collapse|expand)\s+/i,'').slice(0,90);
    const idMatches=(v,id)=>typeof v==='string' && (v===id || v.endsWith('___'+id) || v.endsWith('__'+id));

    const headerNodes = [...channelList.querySelectorAll('[class*="categoryName"], [class*="categoryHeader"], [data-dnd-name]')];
    const targetMarkers = [...channelList.querySelectorAll('[data-list-item-id], [data-channel-id], [data-id], [id]')]
      .filter(el=>[el.id,el.getAttribute('data-list-item-id'),el.getAttribute('data-channel-id'),el.getAttribute('data-id')].some(v=>idMatches(v,categoryId)));
    for (const el of targetMarkers) {
      if (el.closest('a[href]')) continue;
      const ownHeading=el.querySelector('[class*="categoryName"]') || el;
      if (!headerNodes.includes(ownHeading)) headerNodes.push(ownHeading);
    }

    const seenHeader = new Set();
    for (const header of headerNodes) {
      if (!visible(header) || header.closest('a[href]')) continue;
      const name=categoryText(header);
      if (!name || name.length > 95) continue;
      const owner=header.closest('[data-list-item-id], [data-channel-id], li, [role="listitem"]') || header;
      const fields=[header.id,owner.id,...[header,owner].flatMap(el=>['data-list-item-id','data-channel-id','data-id'].map(a=>el.getAttribute(a)))];
      const isTarget=fields.some(v=>idMatches(v,categoryId)) || name.toLowerCase()===categoryName.toLowerCase();
      // Avoid treating every named channel or empty element as a category header.
      const isCategory = isTarget || /categoryName|categoryHeader/.test(header.className?.toString?.()||'');
      if (!isCategory) continue;
      const top=header.getBoundingClientRect().top;
      const key=`${Math.round(top/3)}:${name}`;
      if (seenHeader.has(key)) continue;
      seenHeader.add(key);
      entries.push({type:'category',id:isTarget?categoryId:'other',name,top});
    }
    for (const link of channelList.querySelectorAll('a[href*="/channels/"]')) {
      if (!visible(link)) continue;
      const href=link.getAttribute('href')||'';
      const match=href.match(/^\/channels\/(\d+)\/(\d+)(?:\/)?(?:[?#]|$)/);
      if (!match || match[1]!==serverId || match[2]===categoryId) continue;
      const text=link.querySelector('[class*="name"]')?.textContent || link.getAttribute('data-dnd-name') ||
        link.getAttribute('aria-label') || link.textContent || '';
      entries.push({type:'channel',url:`https://discord.com/channels/${serverId}/${match[2]}`,
        name:String(text).replace(/^#\s*/,'').trim().slice(0,90),top:link.getBoundingClientRect().top});
    }
    // When equally positioned, process category headers before children.
    entries.sort((a,b)=>a.top-b.top || (a.type==='category'?-1:1));
    const position=scroller.scrollTop;
    const max=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
    return {available:true,entries,position,max,atEnd:position >= max-4,
      viewport:scroller.clientHeight};
  },{serverId,categoryId,categoryName});
}

async function scrollChannelSidebar(page, distance) {
  return page.evaluate(distance => {
    const root=document.querySelector('[data-list-id="channels"]') ||
      document.querySelector('nav[aria-label*="Channel"]') ||
      [...document.querySelectorAll('nav, [class*="sidebar"]')].find(el=>el.querySelector('a[href*="/channels/"]'));
    if (!root) return false;
    const canScroll=el=>el && el.clientHeight>90 && el.scrollHeight>el.clientHeight+12 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    let scroller=root;
    while(scroller&&!canScroll(scroller))scroller=scroller.parentElement;
    if(!scroller)scroller=[root,...root.querySelectorAll('[class*="scroller"], [role="presentation"]')].find(canScroll);
    if(!scroller)return false;
    scroller.scrollTop=Math.min(scroller.scrollHeight-scroller.clientHeight,scroller.scrollTop+distance);
    return true;
  },distance);
}

async function goToCategoryStart(page,categoryId) {
  return page.evaluate(id=>{
    const roots=[...document.querySelectorAll('[data-list-item-id], [data-channel-id], [data-id], [id]')];
    const marker=roots.find(el=>[el.id,el.getAttribute('data-list-item-id'),el.getAttribute('data-channel-id'),el.getAttribute('data-id')]
      .some(v=>v===id||v?.endsWith('___'+id)||v?.endsWith('__'+id)));
    if (!marker) return false;
    marker.scrollIntoView({block:'start',inline:'nearest'});
    return true;
  },categoryId);
}

async function discoverCategoryByScrolling(page,categoryId,serverId,{categoryName='',initialChannels=[],maxSteps=MAX_SIDEBAR_STEPS,delayMs=500,logger=console}={}) {
  if(!isSnowflake(categoryId)||!isSnowflake(serverId)) throw new Error('Invalid category/server ID');
  const state={categoryId,serverId,started:false,finished:false,reason:null,
    channels:combineCandidates([],initialChannels.map(ch=>({url:ch.url,name:ch.folder})),serverId,categoryId)};
  const gotoOk=await goToCategoryStart(page,categoryId);
  if(!gotoOk) return {found:false,complete:false,reason:'category-marker-not-rendered',channels:state.channels,steps:0};
  await page.waitForTimeout(350);
  let stagnant=0,steps=0,lastPosition=-1;
  for(;steps<maxSteps;steps++) {
    const snap=await sidebarSnapshot(page,{serverId,categoryId,categoryName});
    if(!snap.available) return {found:state.started,complete:false,reason:snap.reason,channels:state.channels,steps};
    mergeSidebarSnapshot(state,snap);
    if(state.finished) return {found:state.started,complete:true,reason:state.reason,channels:state.channels,steps};
    if(snap.position===lastPosition) stagnant++; else stagnant=0;
    if(stagnant>=3) return {found:state.started,complete:false,reason:'sidebar-stalled',channels:state.channels,steps};
    lastPosition=snap.position;
    const ok=await scrollChannelSidebar(page,Math.max(140,Math.round(snap.viewport*0.65)));
    if(!ok) return {found:state.started,complete:false,reason:'sidebar-not-scrollable',channels:state.channels,steps};
    await page.waitForTimeout(delayMs);
    if((steps+1)%12===0) logger.log(`  Sidebar discovery: ${state.channels.length} channel(s), ${steps+1} scroll steps...`);
  }
  return {found:state.started,complete:false,reason:'discovery-step-limit',channels:state.channels,steps};
}

module.exports={combineCandidates,mergeSidebarSnapshot,discoverCategoryByScrolling,sidebarSnapshot,scrollChannelSidebar,MAX_SIDEBAR_STEPS};
