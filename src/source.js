'use strict';
const {channelId, cleanName} = require('./utils');

function resolveChannelInput(raw, lastUrl = '') {
  const input = String(raw || '').trim();
  if (!input) {
    if (!channelId(lastUrl)) throw new Error('Paste a full Discord channel URL for the first run.');
    return lastUrl;
  }
  if (/^\d{15,22}$/.test(input)) {
    const previous = channelId(lastUrl);
    if (!previous) throw new Error('A channel ID alone requires a saved server ID. Paste a full URL instead.');
    return `https://discord.com/channels/${previous.guild}/${input}`;
  }
  const parsed = channelId(input);
  if (!parsed) throw new Error('Expected https://discord.com/channels/SERVER_ID/CHANNEL_ID');
  return `https://discord.com/channels/${parsed.guild}/${parsed.channel}`;
}

function makeSingleChannelConfig(prior = {}, url, outputRoot) {
  const parsed = channelId(url);
  if (!parsed) throw new Error('Invalid Discord channel URL.');
  const previous = [ ...(prior.channelHistory || []), ...(prior.channels || []) ];
  const byId = new Map();
  for (const ch of previous) {
    const id = channelId(ch.url);
    if (id) byId.set(`${id.guild}/${id.channel}`, ch);
  }
  const selected = byId.get(`${parsed.guild}/${parsed.channel}`);
  const history = new Map();
  for (const ch of [...previous, ...(selected ? [selected] : [])]) {
    const id = channelId(ch.url);
    if (id) history.set(`${id.guild}/${id.channel}`, ch);
  }
  return {
    outputRoot,
    categories: [],
    channels: [{ url, folder: selected?.folder ? cleanName(selected.folder) : '', category: selected?.category ? cleanName(selected.category) : '' }],
    lastChannelUrl: url,
    channelHistory: [...history.values()],
    scrollDelayMs: Math.max(2500, Number(prior.scrollDelayMs) || 2500),
    maxScrolls: prior.maxScrolls || 800,
    stopAfterTopChecks: prior.stopAfterTopChecks || 10,
    maxFileMB: prior.maxFileMB || 1024,
  };
}
function nextChannelInput(raw, lastUrl) {
  // Blank *after* finishing one channel means exit, not rescan it.
  if (!String(raw || '').trim()) return null;
  return resolveChannelInput(raw, lastUrl);
}
module.exports = {resolveChannelInput, makeSingleChannelConfig, nextChannelInput};
