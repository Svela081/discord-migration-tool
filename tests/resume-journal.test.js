'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const {journalNames,verifyJournalOnlyHistory,hasBotJournal}=require('../src/bot-uploader');
const src={sourceChannelId:'999999999999999999',sourceChannelName:'sample',archiveFolder:'Some category/sample'};
const dest={id:'888888888888888888'};
const mid1='777777777777777777';
const mid2='777777777777777778';
async function sandbox(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bot-journal-'));
 const paths=journalNames(root,src,dest);
 await fs.mkdir(path.dirname(paths.journal),{recursive:true});
 return {root,paths,remove:()=>fs.rm(root,{recursive:true,force:true})};
}
async function setJournal(file,ids){
 await fs.writeFile(file,ids.map((id,i)=>JSON.stringify({key:'item'+i,destinationChannelId:dest.id,destinationMessageId:id})).join('\n')+'\n');
}
function pages(...messages){return async(_token,method,resource)=>{
 assert.equal(method,'GET');assert.ok(resource.includes('/channels/'+dest.id+'/messages'));
 return messages.map(id=>({id}));
}}
test('nonempty channel with complete journal is eligible to resume safely',async()=>{
 const t=await sandbox();try{
  await setJournal(t.paths.journal,[mid1,mid2]);
  assert.equal(await hasBotJournal(t.root,src,dest),true);
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages(mid2,mid1)});
  assert.deepEqual(result,{ok:true,verifiedMessages:2});
 }finally{await t.remove();}
});
test('nonempty channel without this tool journal cannot resume',async()=>{
 const t=await sandbox();try{
  assert.equal(await hasBotJournal(t.root,src,dest),false);
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages(mid1)});
  assert.equal(result.ok,false);assert.match(result.reason,/no bot upload journal/);
 }finally{await t.remove();}
});
test('untracked manually or browser-posted message blocks automatic resume',async()=>{
 const t=await sandbox();try{
  await setJournal(t.paths.journal,[mid1]);
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages(mid2,mid1)});
  assert.equal(result.ok,false);assert.match(result.reason,/absent from bot journal/);
 }finally{await t.remove();}
});
test('missing previously posted message blocks automatic resume',async()=>{
 const t=await sandbox();try{
  await setJournal(t.paths.journal,[mid1,mid2]);
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages(mid1)});
  assert.equal(result.ok,false);assert.match(result.reason,/no longer present/);
 }finally{await t.remove();}
});
test('unverified pending upload blocks automatic resume even with complete journal',async()=>{
 const t=await sandbox();try{
  await setJournal(t.paths.journal,[mid1]);
  await fs.writeFile(t.paths.pending,'{"key":"unknown"}');
  assert.equal(await hasBotJournal(t.root,src,dest),true);
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages(mid1)});
  assert.equal(result.ok,false);assert.match(result.reason,/pending|unresolved/i);
 }finally{await t.remove();}
});
test('previous bot-journalled channel empty after deletion must not be treated as fresh',async()=>{
 const t=await sandbox();try{
  await setJournal(t.paths.journal,[mid1]);
  assert.equal(await hasBotJournal(t.root,src,dest),true);
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages()});
  assert.equal(result.ok,false);assert.match(result.reason,/no longer present/);
 }finally{await t.remove();}
});
test('invalid cross-channel journal entry blocks resume',async()=>{
 const t=await sandbox();try{
  await fs.writeFile(t.paths.journal,JSON.stringify({key:'x',destinationChannelId:'123456789012345678',destinationMessageId:mid1})+'\n');
  const result=await verifyJournalOnlyHistory('dummy',t.root,src,dest,{request:pages(mid1)});
  assert.equal(result.ok,false);assert.match(result.reason,/invalid or mismatched/);
 }finally{await t.remove();}
});
