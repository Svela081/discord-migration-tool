'use strict';
// Download-only archive catalog. Never alters previously downloaded media or
// upload journals. Source IDs are the primary keys; display names can change.
const fs = require('node:fs/promises');
const path = require('node:path');
const {expandHome, cleanName, channelId} = require('./utils');
const CATALOG_NAME = 'source_archive_index.json';
function catalogPath(root) { return path.join(expandHome(root), CATALOG_NAME); }
async function readCatalog(root) {
  try {
    const data=JSON.parse(await fs.readFile(catalogPath(root),'utf8'));
    if(data.schemaVersion!==1 || !Array.isArray(data.categories)) throw new Error('Unsupported source archive index schema');
    return data;
  } catch(e) {
    if(e.code==='ENOENT') return {schemaVersion:1,createdAt:new Date().toISOString(),updatedAt:null,categories:[]};
    throw e;
  }
}
async function atomicJson(dest, value) {
  await fs.mkdir(path.dirname(dest),{recursive:true});
  const temporary=dest+`.tmp-${process.pid}`;
  try { await fs.writeFile(temporary, JSON.stringify(value,null,2)+'\n',{mode:0o600}); await fs.rename(temporary,dest); }
  finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
}
function relativeArchiveFolder(root, absolute) {
  const base=path.resolve(expandHome(root));
  const resolved=path.resolve(absolute);
  if(!resolved.startsWith(base+path.sep)) throw new Error('Archive folder must be inside archive root');
  return path.relative(base,resolved).split(path.sep).join('/');
}
async function recordChannel(root, category, sourceChannel, result) {
  const parsed=channelId(sourceChannel.url);
  if(!parsed || parsed.guild!==category.serverId) throw new Error('Source server mismatch in archive index');
  const index=await readCatalog(root);
  let item=index.categories.find(c=>c.sourceServerId===category.serverId && c.sourceCategoryId===category.categoryId);
  if(!item) {
    item={sourceServerId:category.serverId,sourceCategoryId:category.categoryId,
      sourceCategoryName:category.categoryName,archiveCategoryFolder:category.archiveFolder,
      channels:[]};
    index.categories.push(item);
  }
  if(item.archiveCategoryFolder!==category.archiveFolder)
    throw new Error(`Category ${category.categoryId} already uses folder "${item.archiveCategoryFolder}". Use that folder to resume.`);
  item.sourceCategoryName=category.categoryName;
  const status=result?.report?.interrupted?'interrupted':result?.stats?.failed>0?'download-errors':result?.report?.reachedBeginning?'scanned-to-apparent-beginning':'partial-scan';
  const row={sourceChannelId:parsed.channel, sourceChannelName:sourceChannel.folder,sourceChannelUrl:sourceChannel.url,
    archiveFolder:relativeArchiveFolder(root,result.folder),
    downloadManifest:'download_manifest.jsonl',linksFile:'embeds.jsonl',scanReport:'scan_report.json',
    lastScannedAt:result.report.scannedAt,status,stopReason:result.report.stopReason,
    visibleMessageCount:result.report.uniqueVisibleMessages,
    newDownloadsThisScan:result.stats.saved, failedDownloadsThisScan:result.stats.failed,
    reachedBeginningBestEffort:!!result.report.reachedBeginning};
  const i=item.channels.findIndex(c=>c.sourceChannelId===parsed.channel);
  if(i>=0)item.channels[i]=row;else item.channels.push(row);
  index.updatedAt=new Date().toISOString();
  await atomicJson(catalogPath(root),index);
  return row;
}
async function writeChannelMarker(folder,channel) {
  const parsed=channelId(channel.url);
  if(!parsed)throw new Error('Invalid source channel URL');
  const marker=path.join(folder,'.source_channel.json');
  try {
    const prior=JSON.parse(await fs.readFile(marker,'utf8'));
    if(prior.sourceChannelId!==parsed.channel || prior.sourceServerId!==parsed.guild)
      throw new Error(`Folder already belongs to another source channel: ${folder}`);
  }catch(e){if(e.code!=='ENOENT')throw e;}
  await atomicJson(marker,{sourceServerId:parsed.guild,sourceChannelId:parsed.channel,
    sourceChannelUrl:channel.url,sourceChannelName:cleanName(channel.folder),lastSeenAt:new Date().toISOString()});
}
async function inspectLooseFolders(root){
  const base=expandHome(root);
  let entries=[]; try { entries=await fs.readdir(base,{withFileTypes:true}); }
  catch(e){if(e.code!=='ENOENT')throw e;}
  const index=await readCatalog(root);
  const categoryFolderNames=new Set(index.categories.map(c=>c.archiveCategoryFolder));
  const loose=[];
  for(const ent of entries) {
    if(!ent.isDirectory() || ent.name.startsWith('.') || categoryFolderNames.has(ent.name) || /\(category\)$/i.test(ent.name))continue;
    const dir=path.join(base,ent.name);
    const files=await fs.readdir(dir).catch(()=>[]);
    // Flag only plausible prior archives, not arbitrary folders.
    if(files.some(f=>['download_manifest.jsonl','scan_report.json','Images','Videos','embeds.txt','embeds.jsonl'].includes(f)))
      loose.push({folder:ent.name,archivePath:ent.name,classification:'unassigned-legacy-folder',action:'left-unchanged'});
  }
  return loose.sort((a,b)=>a.folder.localeCompare(b.folder));
}
module.exports={readCatalog,recordChannel,writeChannelMarker,inspectLooseFolders,atomicJson,catalogPath,relativeArchiveFolder};
