'use strict';
// Read-only inspection of existing channel archives. No URLs are guessed from
// expired CDN signatures: the browser rescans the original source channels.
const fs = require('node:fs/promises');
const path = require('node:path');
const {loadJsonl} = require('./archive');
const {expandHome, channelId} = require('./utils');
const {readCatalog} = require('./archive-index');

async function readJsonOptional(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; return null; }
}
async function findErrorFolders(base, depth=0, maxDepth=4) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await fs.readdir(base, {withFileTypes:true}); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const found = [];
  if (entries.some(e => e.isFile() && e.name === 'errors.jsonl')) found.push(base);
  if (depth === maxDepth) return found;
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || ['Images','Videos','node_modules','.git','.archive-reports','.migration-maps'].includes(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    found.push(...await findErrorFolders(path.join(base,e.name),depth+1,maxDepth));
  }
  return found;
}
function unresolvedPaths(errors, completed) {
  const successful = new Set(completed.map(x=>x.sourcePath).filter(x=>typeof x === 'string'));
  const unresolved = new Map();
  for (const e of errors) {
    if (typeof e.sourcePath !== 'string' || !/^\/(?:ephemeral-)?attachments\//i.test(e.sourcePath)) continue;
    if (!successful.has(e.sourcePath)) unresolved.set(e.sourcePath, {sourcePath:e.sourcePath, error:String(e.error||'unknown'), lastFailedAt:e.at||null, messageId:e.messageId||null});
  }
  return [...unresolved.values()];
}
function insideRoot(root, folder) {
  const rel=path.relative(root,folder);
  return !!rel && !rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel);
}
async function channelUrlFor(folder, indexed) {
  const marker=await readJsonOptional(path.join(folder,'.source_channel.json'));
  const report=await readJsonOptional(path.join(folder,'scan_report.json'));
  const candidates=[marker?.sourceChannelUrl,indexed?.sourceChannelUrl,report?.channelUrl];
  const valid=candidates.map(url=>({url,id:channelId(url)})).filter(x=>x.id);
  if (!valid.length) return {url:null, issue:'No reliable source channel URL in archive metadata'};
  const uniqueIds=new Set(valid.map(v=>`${v.id.guild}/${v.id.channel}`));
  if (uniqueIds.size>1) return {url:null,issue:'Conflicting source channel IDs in archive metadata'};
  return {url:valid[0].url, issue:null};
}
async function inventoryFailedArchives(root) {
  const base=path.resolve(expandHome(root));
  const catalog=await readCatalog(root);
  const indexed=new Map();
  for (const cat of catalog.categories) for (const ch of cat.channels||[]) {
    if (typeof ch.archiveFolder!=='string')continue;
    const folder=path.resolve(base,ch.archiveFolder);
    if (insideRoot(base,folder)) indexed.set(folder,ch);
  }
  const dirs=await findErrorFolders(base);
  const affected=[];
  let resolvedHistorical=0;
  for (const folder of dirs) {
    if (!insideRoot(base,folder))continue;
    const [errors,completed]=await Promise.all([
      loadJsonl(path.join(folder,'errors.jsonl')),
      loadJsonl(path.join(folder,'download_manifest.jsonl'))]);
    const unresolved=unresolvedPaths(errors,completed);
    resolvedHistorical += errors.length-unresolved.length;
    if (!unresolved.length)continue;
    const {url,issue}=await channelUrlFor(folder,indexed.get(folder));
    affected.push({folder, relativeFolder:path.relative(base,folder), sourceChannelUrl:url,
      issue,unresolved,failedCount:unresolved.length});
  }
  affected.sort((a,b)=>a.relativeFolder.localeCompare(b.relativeFolder));
  return {root:base,affected,scannedErrorFolders:dirs.length,resolvedHistorical};
}
module.exports={unresolvedPaths,findErrorFolders,inventoryFailedArchives,channelUrlFor};
