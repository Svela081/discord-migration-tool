'use strict';
const {channelId} = require('./utils');
const {guildChannels, destinationCategory, sameName} = require('./bot-uploader');
const {categoryKey} = require('./settings');

// A channel/category URL identifies both IDs through the bot API. A bare server
// ID retains the create-a-new-category workflow when no anchor exists yet.
async function chooseDestination(cli, token, category, settings = {}, api = {guildChannels, destinationCategory}) {
  const previous = settings.destinationCategories?.[categoryKey(category)];
  const defaultTarget = previous
    ? `https://discord.com/channels/${previous.serverId}/${previous.categoryId}`
    : settings.destinationServerId || '';
  const prompt = `DESTINATION channel URL or server ID${defaultTarget ? ` [${defaultTarget}]` : ''}: `;
  const raw = (await cli.question(prompt)).trim() || defaultTarget;
  if (channelId(raw)) {
    const target = await api.destinationCategory(token, raw);
    if (!target.categoryName || target.categoryName === '(category)')
      throw new Error('Could not verify the destination category name. Use its server ID instead.');
    return {guildId: target.guildId, targetName: target.categoryName, specificId: target.categoryId,
      rows: await api.guildChannels(token, target.guildId)};
  }
  if (!/^\d{15,22}$/.test(raw))
    throw new Error('Paste a full destination channel URL or the destination SERVER ID.');
  let rows;
  try { rows = await api.guildChannels(token, raw); }
  catch (error) {
    if (/HTTP 404/.test(error.message))
      throw new Error('Destination server not found. Copy the SERVER ID (not a category ID), or paste a channel URL. Check that the bot is installed there.');
    throw error;
  }
  const saved = previous?.serverId === raw ? rows.find(row => row.type === 4 && row.id === previous.categoryId) : null;
  const defaultName = saved?.name || category.sourceCategoryName;
  const targetName = (await cli.question(`Destination category name [${defaultName}]: `)).trim() || defaultName;
  if (!targetName || targetName.length > 100) throw new Error('Invalid destination category name.');
  const matches = rows.filter(row => row.type === 4 && sameName(row.name, targetName));
  let specificId = null;
  if (saved && sameName(saved.name, targetName)) specificId = saved.id;
  else if (matches.length > 1) {
    console.log('Several categories share that name:');
    for (const match of matches) console.log(`  ${match.name} (${match.id})`);
    specificId = (await cli.question('Exact DESTINATION category ID: ')).trim();
    if (!matches.some(row => row.id === specificId)) throw new Error('Choose one of the listed destination category IDs.');
  }
  return {guildId: raw, targetName, specificId, rows};
}
module.exports = {chooseDestination};
