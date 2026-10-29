'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {reconcileInventory,reconcilePair,historyFingerprint,fetchCompleteHistory,countArchiveFailures,attachmentDigest}=require('../src/reconcile');
const {migratePair,journalNames}=require('../src/bot-uploader');
const digest = s=>createHash('sha256').update(s).digest('hex');
const srcId='999999999999999999', dstId='888888888888888888', mid='777777777777777777';
const src={sourceChannelId:srcId,sourceChannelName:'sample',archiveFolder:'Cat/sample'};
const dest={id:dstId,name:'sample'};
const remote=(filename,size,content='x',id=mid)=>({id,filename,size,url:`https://cdn.discordapp.com/attachments/888888888888888888/111111111111111111/${encodeURIComponent(filename)}`,mockDigest:digest(content)});
const message=(id=mid,attachments=[],content='')=>({id,attachments,content});
const media=(key,file)=>({type:'media',key:'media:'+key,file,absolute:'/fake/'+file});
const link=(url)=>({type:'link',key:'link:'+url,url});
const pretendStat=fs.stat;
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reconcile-v1202-'));
 const folder=path.join(root,'Cat','sample');await fs.mkdir(path.join(folder,'Images'),{recursive:true});
 return {root,folder,cleanup:()=>fs.rm(root,{recursive:true,force:true})};
}
function fakeHistory(messages){return async(_t,method,resource)=>{
 assert.equal(method,'GET');assert.ok(resource.includes('/channels/'+dstId+'/messages'));
 return messages;
};}
async function seed(t,mediaFiles=[],links=[]){
 const manifest=[];
 for(const [i,entry] of mediaFiles.entries()){
  const file=`Images/${entry.name}`;
  await fs.writeFile(path.join(t.folder,file),entry.bytes);
  manifest.push({sourcePath:`/old/attachments/${i}`,file,messageId:'777777777777777777'});
 }
 await fs.writeFile(path.join(t.folder,'download_manifest.jsonl'),manifest.map(e=>JSON.stringify(e)).join('\n')+'\n');
 await fs.writeFile(path.join(t.folder,'embeds.jsonl'),links.map(url=>JSON.stringify({url,messageId:mid})).join('\n')+'\n');
}
test('history pagination reads all messages, refuses incomplete last-page scan', async()=>{
 const one=Array.from({length:100},(_,i)=>message(String(777777777777777799n-BigInt(i))));
 const more=[message('777777777777777600')];let calls=0;
 const request=async()=>{calls++;return calls===1?one:more;};
 const rows=await fetchCompleteHistory('bot',dstId,{request});
 assert.equal(rows.length,101);assert.equal(calls,2);
 await assert.rejects(()=>fetchCompleteHistory('bot',dstId,{request:async()=>one,maxPages:1}),/cannot verify full history/);
});
test('history fingerprint changes when attachment metadata or text changes',()=>{
 const base=[message(mid,[remote('a.jpg',2)],'a')];
 assert.notEqual(historyFingerprint(base),historyFingerprint([message(mid,[remote('a.jpg',3)],'a')]));
 assert.notEqual(historyFingerprint(base),historyFingerprint([message(mid,[remote('a.jpg',2)],'b')]));
});
test('exact filename, byte size and SHA256 prove a matching file is already present',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'same.jpg',bytes:'abcdef'}]);
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[remote('same.jpg',6,'abcdef')])]),
   getRemoteHash:async(a)=>a.mockDigest});
  assert.equal(r.present.length,1);assert.equal(r.missing.length,0);assert.equal(r.uncertain.length,0);assert.equal(r.safeToUpload,true);
 }finally{await t.cleanup();}
});
test('same filename and size but different bytes is UNCERTAIN, never eligible',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'same.jpg',bytes:'abcdef'}]);
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[remote('same.jpg',6,'ghijkl')])]),
   getRemoteHash:async a=>a.mockDigest});
  assert.equal(r.uncertain.length,1);assert.equal(r.safeToUpload,false);
 }finally{await t.cleanup();}
});
test('a different-size remote file with the same filename is uncertain',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'same.jpg',bytes:'abcdef'}]);
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[remote('same.jpg',7,'abcdefg')])]),
   getRemoteHash:async a=>a.mockDigest});
  assert.equal(r.uncertain.length,1);
 }finally{await t.cleanup();}
});
test('previous manual/browser file is present but other files remain missing',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'same.jpg',bytes:'abcdef'},{name:'missing.jpg',bytes:'1234567'}]);
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[remote('same.jpg',6,'abcdef')])]),
   getRemoteHash:async a=>a.mockDigest});
  assert.equal(r.present.length,1);assert.equal(r.missing.length,1);assert.equal(r.safeToUpload,true);
 }finally{await t.cleanup();}
});
test('repeated indistinguishable local attachments cannot be safely disambiguated',async()=>{
 const t=await fixture();try{
  await fs.mkdir(path.join(t.folder,'Videos'),{recursive:true});
  const a=path.join(t.folder,'Images','foo.mov'),b=path.join(t.folder,'Videos','foo.mov');
  await fs.writeFile(a,'abcdef');await fs.writeFile(b,'abcdef');
  const list=[{type:'media',key:'media:one',file:'Images/foo.mov',absolute:a},
   {type:'media',key:'media:two',file:'Videos/foo.mov',absolute:b}];
  const outcome=await reconcileInventory(list,[message(mid,[remote('foo.mov',6,'abcdef')])],{
   getRemoteHash:async a=>a.mockDigest});
  assert.equal(outcome.get('media:one').state,'uncertain');
  assert.equal(outcome.get('media:two').state,'uncertain');
 }finally{await t.cleanup();}
});
test('renamed destination attachments with identical bytes are considered present',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'image-abc.jpg',bytes:'abcdef'}]);
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[remote('renamed-image.jpg',6,'abcdef')])]),
   getRemoteHash:async a=>a.mockDigest});
  assert.equal(r.present.length,1);assert.match(r.present[0].reason,/filename differs/);
 }finally{await t.cleanup();}
});
test('failed hash of matching-size renamed attachment blocks auto-upload',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'image-abc.jpg',bytes:'abcdef'}]);
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[remote('renamed-image.jpg',6,'abcdef')])]),
   getRemoteHash:async()=>{throw new Error('CDN expired');}});
  assert.equal(r.uncertain.length,1);assert.equal(r.safeToUpload,false);
 }finally{await t.cleanup();}
});
test('exact standalone links are present; embedded links are held for review',async()=>{
 const url='https://mega.nz/file/abc#xyz';
 const a=await reconcileInventory([link(url)],[message(mid,[],url)]);
 assert.equal(a.get('link:'+url).state,'present');
 const b=await reconcileInventory([link(url)],[message(mid,[],'See '+url+' here')]);
 assert.equal(b.get('link:'+url).state,'uncertain');
 const c=await reconcileInventory([link(url)],[]);
 assert.equal(c.get('link:'+url).state,'missing');
});
test('pending uncertain upload blocks automatic reconciliation',async()=>{
 const t=await fixture();try{
  await seed(t,[],['https://mega.nz/file/abc#xyz']);
  const paths=journalNames(t.root,src,dest);await fs.mkdir(path.dirname(paths.pending),{recursive:true});
  await fs.writeFile(paths.pending,JSON.stringify({key:'link:https://mega.nz/file/abc#xyz'}));
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([message(mid,[],'')])});
  assert.match(r.hardStop,/pending/i);assert.equal(r.safeToUpload,false);
 }finally{await t.cleanup();}
});
test('deleted bot journal message blocks uploads rather than assuming missing',async()=>{
 const t=await fixture();try{
  await seed(t,[],['https://mega.nz/file/abc#xyz']);
  const paths=journalNames(t.root,src,dest);await fs.mkdir(path.dirname(paths.journal),{recursive:true});
  await fs.writeFile(paths.journal,JSON.stringify({key:'link:https://mega.nz/file/abc#xyz',destinationMessageId:mid,destinationChannelId:dest.id})+'\n');
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([])});
  assert.match(r.hardStop,/journal/i);assert.equal(r.safeToUpload,false);
 }finally{await t.cleanup();}
});
test('manifests resolve historic fetch failures without editing errors.jsonl',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'resolved.jpg',bytes:'xyz'}]);
  await fs.writeFile(path.join(t.folder,'errors.jsonl'),[
   {sourcePath:'/old/attachments/0',error:'fetch failed'},
   {sourcePath:'/old/attachments/1',error:'fetch failed'},
   {sourcePath:'/old/attachments/1',error:'fetch failed'}
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.equal(await countArchiveFailures(t.folder),1);
 }finally{await t.cleanup();}
});
test('migratePair skips verified browser-uploaded items and posts missing ones only',async()=>{
 const t=await fixture();const original=global.fetch;
 try{
  await seed(t,[{name:'already.jpg',bytes:'aaa'},{name:'new.jpg',bytes:'bbb'}]);
  let calls=0;
  global.fetch=async(_url,opt)=>{calls++;assert.equal(opt.method,'POST');
   return new Response(JSON.stringify({id:mid,channel_id:dstId}),{status:200});};
  const result=await migratePair('token',t.root,src,dest,{verifiedPresentKeys:new Set(['media:/old/attachments/0']),
   logger:{log(){},warn(){},error(){}}});
  assert.equal(result.posted,1);assert.equal(result.alreadyPresent,1);assert.equal(calls,1);
 }finally{global.fetch=original;await t.cleanup();}
});
test('remote hash verifier rejects non-Discord URLs without fetching',async()=>{
 await assert.rejects(()=>attachmentDigest({url:'https://example.com/a.jpg',size:1}),/approved Discord CDN/);
});
test('missing manifest-listed files are reported instead of silently forgotten',async()=>{
 const t=await fixture();try{
  await seed(t,[{name:'lost.jpg',bytes:'abc'}]);
  await fs.rm(path.join(t.folder,'Images','lost.jpg'));
  const r=await reconcilePair('token',t.root,src,dest,{request:fakeHistory([])});
  assert.equal(r.missingLocalManifestFiles,1);
 }finally{await t.cleanup();}
});
