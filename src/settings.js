'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {loadEnvFile} = require('node:process');
const {atomicJson} = require('./archive-index');

function loadLocalEnv(directory) {
  try { loadEnvFile(path.join(directory, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function publicSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('config.json must contain a JSON object.');
  const result = {};
  if (value.outputRoot !== undefined) {
    if (typeof value.outputRoot !== 'string' || !value.outputRoot.trim())
      throw new Error('config.json outputRoot must be a nonempty folder path.');
    result.outputRoot = value.outputRoot.trim();
  }
  if (value.destinationServerId) {
    if (typeof value.destinationServerId !== 'string' || !/^\d{15,22}$/.test(value.destinationServerId))
      throw new Error('config.json destinationServerId must be an ID in quotes.');
    result.destinationServerId = value.destinationServerId;
  }
  // Persist only known non-credential fields. Tokens belong in .env or the shell.
  if (value.destinationCategories && typeof value.destinationCategories === 'object' && !Array.isArray(value.destinationCategories)) {
    result.destinationCategories = Object.fromEntries(Object.entries(value.destinationCategories).filter(([key, item]) =>
      /^\d{15,22}:\d{15,22}$/.test(key) && item &&
      /^\d{15,22}$/.test(item.serverId) && /^\d{15,22}$/.test(item.categoryId) &&
      typeof item.categoryName === 'string' && item.categoryName.length > 0 && item.categoryName.length <= 100
    ).map(([key, item]) => [key, {serverId: item.serverId, categoryId: item.categoryId, categoryName: item.categoryName}]));
  }
  return result;
}

async function readSettings(directory) {
  try { return publicSettings(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function saveSettings(directory, value) {
  await atomicJson(path.join(directory, 'config.json'), publicSettings(value));
}
function categoryKey(category) {
  return `${category.sourceServerId}:${category.sourceCategoryId}`;
}
module.exports = {loadLocalEnv, publicSettings, readSettings, saveSettings, categoryKey};
