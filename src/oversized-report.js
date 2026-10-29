'use strict';
// Local-only inventory. Never calls Discord and never changes archived media.
const fs = require('node:fs/promises');
const path = require('node:path');
const {readCatalog,atomicJson} = require('./archive-index');
const {expandHome} = require('./utils');
const {MAX_BOT_FILE_BYTES} = require('./bot-uploader');

const VALID_MEDIA = /\.(?:png|jpe?g|gif|webp|heic|heif|tiff?|bmp|avif|mp4|mov|m4v|mkv|webm|avi|wmv|mpeg|mpg|3gp)$/i;
const IGNORED_DIRS = new Set(['node_modules','.git','.bot-migration-journals','.archive-reports','.migration-maps']);
const toRel = (root, p) => path.relative(root,p).split(path.sep).join('/');
function csvCell(value) {return '"'+String(value??'').replace(/"/g,'""')+'"';}
async function readMappings(base) {
  const folder=path.join(base,'.bot-migration-journals');
  let files=[];try{files=await fs.readdir(folder);}catch(e){if(e.code!=='ENOENT')throw e;}
  const mapping=new Map();
  for(const file of files.filter(x=>/^structure-.*\.json$/.test(x)).sort()) {
    let data;try{data=JSON.parse(await fs.readFile(path.join(folder,file),'utf8'));}
    catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)continue;throw e;}
    if(!/^\d{15,22}$/.test(String(data.guildId||'')))continue;
    for(const row of data.mappings||[]){
      if(!row.sourceChannelId||!row.destinationChannelId)continue;
      mapping.set(String(row.sourceChannelId),{
        destinationServerId:String(data.guildId),destinationChannelId:String(row.destinationChannelId),
        destinationCategoryId:String(data.categoryId||''),mappingReport:file
      });
    }
  }
  return mapping;
}
async function collectOversized(root,{cutoffBytes=MAX_BOT_FILE_BYTES}={}){
  const base=path.resolve(expandHome(root));
  const index=await readCatalog(base);
  const byDir=new Map();
  for(const category of index.categories||[])for(const channel of category.channels||[]){
    const channelDir=path.resolve(base,String(channel.archiveFolder||''));
    if(!channel.archiveFolder||!channelDir.startsWith(base+path.sep))continue;
    byDir.set(channelDir,{category:category.sourceCategoryName,archiveCategoryFolder:category.archiveCategoryFolder,
      sourceChannelName:channel.sourceChannelName,sourceChannelId:channel.sourceChannelId,
      sourceCategoryId:category.sourceCategoryId,indexed:true});
  }
  const mappings=await readMappings(base);
  const channels=new Map();
  let visitedFiles=0;
  async function walk(folder,depth=0){
    if(depth>5)return;
    let entries=[];
    try{entries=await fs.readdir(folder,{withFileTypes:true});}
    catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const dirent of entries){
      const name=dirent.name;
      if(dirent.isSymbolicLink())continue; // Never traverse symlinks outside the archive.
      const absolute=path.join(folder,name);
      if(dirent.isDirectory()){
        if((name.startsWith('.')&&name!=='Images'&&name!=='Videos')||IGNORED_DIRS.has(name))continue;
        await walk(absolute,depth+1);
        continue;
      }
      if(!dirent.isFile()||!VALID_MEDIA.test(name)||name.includes('.part-'))continue;
      const parent=path.basename(path.dirname(absolute));
      if(parent!=='Images'&&parent!=='Videos')continue;
      visitedFiles++;
      const stat=await fs.stat(absolute);
      if(stat.size<=cutoffBytes)continue;
      const folderOfChannel=path.dirname(path.dirname(absolute));
      const info=byDir.get(folderOfChannel)||{};
      const rel=toRel(base,folderOfChannel);
      const parts=rel.split('/');
      const inferredCategory=parts.length>1?parts.slice(0,-1).join('/'):'(legacy/loose folder)';
      const mapped=mappings.get(String(info.sourceChannelId||''))||{};
      if(!channels.has(rel))channels.set(rel,{
        category:info.category||inferredCategory,
        sourceCategoryId:info.sourceCategoryId||null,
        sourceChannelName:info.sourceChannelName||parts.at(-1),
        sourceChannelId:info.sourceChannelId||null,
        archiveFolder:rel,
        indexed:!!info.indexed,
        destinationServerId:mapped.destinationServerId||null,
        destinationChannelId:mapped.destinationChannelId||null,
        destinationCategoryId:mapped.destinationCategoryId||null,
        destinationMappingSource:mapped.mappingReport||null,
        files:[]
      });
      channels.get(rel).files.push({file:toRel(folderOfChannel,absolute),
        absolutePath:absolute,bytes:stat.size,MiB:Math.round(stat.size/1048576*100)/100,
        status:'MANUAL_REVIEW_REQUIRED',
        explanation:'Larger than this bot importer’s configured cutoff. File may already exist in Discord; verify before manual upload.'});
    }
  }
  await walk(base);
  const grouped=[...channels.values()].sort((a,b)=>a.category.localeCompare(b.category)||a.sourceChannelName.localeCompare(b.sourceChannelName));
  for(const ch of grouped)ch.files.sort((a,b)=>a.file.localeCompare(b.file));
  return {version:require('../package.json').version,generatedAt:new Date().toISOString(),archiveRoot:base,cutoffBytes,
    note:'Files exceed the bot cutoff; this LOCAL report cannot establish whether a file has already been manually uploaded. Verify destination before posting. Existing archive files are unchanged.',
    scannedMediaFiles:visitedFiles,affectedChannels:grouped.length,
    oversizedFiles:grouped.reduce((n,c)=>n+c.files.length,0),channels:grouped};
}
async function writeOversizedReport(root,inventory) {
  const dir=path.join(path.resolve(expandHome(root)),'.bot-migration-journals');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const json=path.join(dir,`manual-oversized-${stamp}.json`);
  const csv=path.join(dir,`manual-oversized-${stamp}.csv`);
  await atomicJson(json,inventory);
  const rows=[['Category','Channel','Destination Channel ID (last mapped)','Archive Folder',
    'File','MiB','Bytes','Status','Absolute Path']];
  for(const c of inventory.channels)for(const f of c.files)rows.push([
    c.category,c.sourceChannelName,c.destinationChannelId||'',c.archiveFolder,
    f.file,f.MiB,f.bytes,f.status,f.absolutePath]);
  await fs.writeFile(csv,rows.map(row=>row.map(csvCell).join(',')).join('\n')+'\n',{mode:0o600});
  return {json,csv};
}
module.exports={collectOversized,writeOversizedReport,readMappings};
