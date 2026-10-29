'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {collectOversized,writeOversizedReport}=require('../src/oversized-report');
const {reconcilePair}=require('../src/reconcile');
const {migratePair,journalNames,MAX_BOT_FILE_BYTES}=require('../src/bot-uploader');
const {atomicJson}=require('../src/archive-index');
const sourceId='999999999999999999',targetId='888888888888888888',messageId='777777777777777777';
const source={sourceChannelId:sourceId,sourceChannelName:'sample',archiveFolder:'Sample Archive (category)/sample'};
const target={id:targetId,name:'sample'};
async function setup(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dmt-oversize-'));
 const folder=path.join(root,'Sample Archive (category)','sample');
 await fs.mkdir(path.join(folder,'Videos'),{recursive:true});
 await fs.mkdir(path.join(folder,'Images'),{recursive:true});
 const video=path.join(folder,'Videos','RPReplay.mov');
 await fs.writeFile(video,'x');await fs.truncate(video,MAX_BOT_FILE_BYTES+1);
 const image=path.join(folder,'Images','small.jpg');await fs.writeFile(image,'small');
 await fs.writeFile(path.join(folder,'download_manifest.jsonl'),[
  {sourcePath:'/attachments/old/video',file:'Videos/RPReplay.mov',messageId:messageId},
  {sourcePath:'/attachments/old/photo',file:'Images/small.jpg',messageId:messageId}
 ].map(x=>JSON.stringify(x)).join('\n')+'\n');
 await atomicJson(path.join(root,'source_archive_index.json'),{schemaVersion:1,categories:[{
  sourceServerId:'666666666666666666',sourceCategoryId:'555555555555555555',sourceCategoryName:'Sample Archive',
  archiveCategoryFolder:'Sample Archive (category)',channels:[source]
 }]});
 return {root,folder,video,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
test('offline oversized report covers indexed and loose folders, excludes hidden journal data',async()=>{
 const t=await setup();try{
  const loose=path.join(t.root,'old-loose','Videos');await fs.mkdir(loose,{recursive:true});
  await fs.writeFile(path.join(loose,'other.mp4'),'x');await fs.truncate(path.join(loose,'other.mp4'),MAX_BOT_FILE_BYTES+10);
  await fs.mkdir(path.join(t.root,'.bot-migration-journals','Videos'),{recursive:true});
  await fs.writeFile(path.join(t.root,'.bot-migration-journals','Videos','ignore.mp4'),'x');
  await fs.truncate(path.join(t.root,'.bot-migration-journals','Videos','ignore.mp4'),MAX_BOT_FILE_BYTES+10);
  await atomicJson(path.join(t.root,'.bot-migration-journals','structure-2026-01-01.json'),{
   guildId:'666666666666666666',categoryId:'555555555555555555',mappings:[
   {sourceChannelId:sourceId,destinationChannelId:targetId}]});
  const report=await collectOversized(t.root);
  assert.equal(report.oversizedFiles,2);assert.equal(report.affectedChannels,2);
  assert.equal(report.channels.find(c=>c.indexed).destinationChannelId,targetId);
  assert.equal(report.channels.find(c=>!c.indexed).sourceChannelName,'old-loose');
  const paths=await writeOversizedReport(t.root,report);
  assert.match(await fs.readFile(paths.csv,'utf8'),/RPReplay.mov/);
  assert.match(await fs.readFile(paths.json,'utf8'),/other.mp4/);
 }finally{await t.cleanup();}
});
test('reconciler separates oversized pending marker from bot-eligible small missing content',async()=>{
 const t=await setup();try{
  const p=journalNames(t.root,source,target);await fs.mkdir(path.dirname(p.pending),{recursive:true});
  const marker={key:'media:/attachments/old/video',sourceChannelId:sourceId,destinationChannelId:targetId,
   file:'Videos/RPReplay.mov'};
  await fs.writeFile(p.pending,JSON.stringify(marker));
  const r=await reconcilePair('fake',t.root,source,target,{request:async()=>[]});
  assert.equal(r.safeToUpload,true);assert.equal(r.hardStop,null);
  assert.equal(r.missing.length,1);assert.equal(r.oversized.length,1);
  assert.equal(r.oversized[0].pendingMarker,true);
  assert.equal(JSON.parse(await fs.readFile(p.pending,'utf8')).key,marker.key);
 }finally{await t.cleanup();}
});
test('uploader keeps oversized pending marker in manual review file and uploads only smaller item',async()=>{
 const t=await setup(),original=global.fetch;try{
  const p=journalNames(t.root,source,target);await fs.mkdir(path.dirname(p.pending),{recursive:true});
  await fs.writeFile(p.pending,JSON.stringify({key:'media:/attachments/old/video',sourceChannelId:sourceId,
   destinationChannelId:targetId,file:'Videos/RPReplay.mov'}));
  let calls=0;
  global.fetch=async(_url,opts)=>{calls++;assert.equal(opts.method,'POST');return new Response(
   JSON.stringify({id:messageId,channel_id:targetId}),{status:200});};
  const outcome=await migratePair('fake',t.root,source,target,{logger:{log(){},warn(){},error(){}}});
  assert.equal(outcome.posted,1);assert.equal(outcome.oversized.length,1);assert.equal(calls,1);
  const entries=await fs.readdir(path.dirname(p.pending));
  const moved=entries.find(x=>x.includes('.oversized-pending-'));
  assert.ok(moved,'oversized pending marker is preserved under a manual-review filename');
  assert.match(await fs.readFile(path.join(path.dirname(p.pending),moved),'utf8'),/RPReplay.mov/);
  await assert.rejects(()=>fs.stat(p.pending),{code:'ENOENT'});
 }finally{global.fetch=original;await t.cleanup();}
});
