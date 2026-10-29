'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {recordChannel,readCatalog,writeChannelMarker,inspectLooseFolders}=require('../src/archive-index');
const {selectThroughChannel}=require('../src/source-boundary');
const S='1111111111111111111',C='2222222222222222222',A='3333333333333333333',B='4444444444444444444';
async function temp(fn){const root=await fs.mkdtemp(path.join(os.tmpdir(),'dm-archive-'));
  try{return await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
function rec(root,id,name,category='Sample Archive (category)'){
  const folder=path.join(root,category,name);
  return {source:{url:`https://discord.com/channels/${S}/${id}`,folder:name},result:{folder,
    report:{scannedAt:'2026-10-23T02:00:00Z',reachedBeginning:true,stopReason:'stable-oldest-message-boundary',uniqueVisibleMessages:10},
    stats:{saved:2,failed:0}}};
}
test('category source-index names files with server, category and source channel IDs',async()=>temp(async root=>{
  const category={serverId:S,categoryId:C,categoryName:'Sample Archive',archiveFolder:'Sample Archive (category)'};
  const a=rec(root,A,'photos');
  const row=await recordChannel(root,category,a.source,a.result);
  assert.equal(row.archiveFolder,'Sample Archive (category)/photos');
  assert.equal(row.status,'scanned-to-apparent-beginning');
  const index=await readCatalog(root);
  assert.equal(index.categories[0].sourceServerId,S);
  assert.equal(index.categories[0].sourceCategoryId,C);
  assert.equal(index.categories[0].channels[0].sourceChannelId,A);
}));
test('rerun updates same source channel rather than adding a duplicate index entry',async()=>temp(async root=>{
  const category={serverId:S,categoryId:C,categoryName:'Sample Archive',archiveFolder:'Sample Archive (category)'};
  const r=rec(root,A,'photos');
  await recordChannel(root,category,r.source,r.result);
  await recordChannel(root,category,r.source,r.result);
  const index=await readCatalog(root);
  assert.equal(index.categories.length,1);
  assert.equal(index.categories[0].channels.length,1);
}));
test('does not merge different categories into same archive category directory',async()=>temp(async root=>{
  const category={serverId:S,categoryId:C,categoryName:'Sample Archive',archiveFolder:'Sample Archive (category)'};
  const r=rec(root,A,'photos');
  await recordChannel(root,category,r.source,r.result);
  await assert.rejects(()=>recordChannel(root,{...category,archiveFolder:'Other Folder'},r.source,{...r.result,folder:path.join(root,'Other Folder','photos')}),/already uses folder/);
}));
test('marker catches folder name collisions and never overwrites old ownership',async()=>temp(async root=>{
  const folder=path.join(root,'Sample Archive (category)','photos');
  await writeChannelMarker(folder,{url:`https://discord.com/channels/${S}/${A}`,folder:'photos'});
  await assert.rejects(()=>writeChannelMarker(folder,{url:`https://discord.com/channels/${S}/${B}`,folder:'photos'}),/already belongs/);
  const saved=JSON.parse(await fs.readFile(path.join(folder,'.source_channel.json'),'utf8'));
  assert.equal(saved.sourceChannelId,A);
}));
test('loose legacy archive folders are inventoried without being moved or deleted',async()=>temp(async root=>{
  await fs.mkdir(path.join(root,'loose-photos','Images'),{recursive:true});
  await fs.mkdir(path.join(root,'Sample Archive (category)','photos'),{recursive:true});
  await fs.writeFile(path.join(root,'loose-photos','scan_report.json'),'{}');
  const loose=await inspectLooseFolders(root);
  assert.deepEqual(loose.map(x=>x.folder),['loose-photos']);
  assert.equal((await fs.stat(path.join(root,'loose-photos','Images'))).isDirectory(),true);
}));
test('source boundary excludes channels after confirmed endpoint',()=>{
  const channels=[{id:'1'},{id:'2'},{id:'3'},{id:'4'}];
  assert.deepEqual(selectThroughChannel(channels,'1','3').map(x=>x.id),['1','2','3']);
});
test('download-only CLI has no destination posting workflow',async()=>{
  const code=await fs.readFile(path.join(__dirname,'..','index.js'),'utf8');
  assert.doesNotMatch(code,/transferViaBrowser|focusDestination|ensureTextChannel|destinationPage|DESTINATION anchor/);
  assert.match(code,/Type DOWNLOAD to begin/);
});
