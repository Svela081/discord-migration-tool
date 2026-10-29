'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {unresolvedPaths,inventoryFailedArchives}=require('../src/retry-failed');
const {ChannelArchive}=require('../src/archive');

const A='/attachments/1234/5678/first.png';
const B='/attachments/1234/9876/second.mov';
const url=id=>`https://cdn.discordapp.com${id}?ex=old&hm=expired`;
async function withRoot(fn) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'discord-retry-'));try{return await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
async function jsonl(file,rows){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}

test('Unresolved entries are deduplicated by pathname, not expired signatures; successes override past errors',()=>{
  const errors=[{sourcePath:A,error:'fetch failed'},{sourcePath:A,error:'HTTP 403'},{sourcePath:B,error:'fetch failed'}, {sourcePath:'javascript:bad',error:'bad'}];
  const rows=unresolvedPaths(errors,[{sourcePath:A,file:'Images/first.png'}]);
  assert.equal(rows.length,1);assert.equal(rows[0].sourcePath,B);
});

test('Finds category and loose-folder errors, skips resolved logs and does not alter user files',async()=>withRoot(async root=>{
  const channel=path.join(root,'Sample Archive (category)','photos');
  const loose=path.join(root,'legacy-photos');
  const resolved=path.join(root,'Sample Archive (category)','resolved-photos');
  await jsonl(path.join(channel,'errors.jsonl'),[{sourcePath:A,error:'fetch failed'},{sourcePath:A,error:'fetch failed'}, {sourcePath:B,error:'HTTP 403'}]);
  await jsonl(path.join(channel,'download_manifest.jsonl'),[{sourcePath:B,file:'Videos/second.mov'}]);
  await fs.writeFile(path.join(channel,'.source_channel.json'),JSON.stringify({sourceChannelUrl:'https://discord.com/channels/12345678901234567/98765432109876543'}));
  await jsonl(path.join(loose,'errors.jsonl'),[{sourcePath:B,error:'fetch failed'}]);
  await fs.writeFile(path.join(loose,'scan_report.json'),JSON.stringify({channelUrl:'https://discord.com/channels/12345678901234567/88888888888888888'}));
  await jsonl(path.join(resolved,'errors.jsonl'),[{sourcePath:A,error:'fetch failed'}]);
  await jsonl(path.join(resolved,'download_manifest.jsonl'),[{sourcePath:A,file:'Images/first.png'}]);
  const result=await inventoryFailedArchives(root);
  assert.equal(result.scannedErrorFolders,3);
  assert.equal(result.affected.length,2);
  const indexed=result.affected.find(row=>row.folder===channel);
  assert.equal(indexed.unresolved.length,1);
  assert.equal(indexed.unresolved[0].sourcePath,A);
  assert.ok(result.affected.some(row=>row.relativeFolder==='legacy-photos'));
  assert.ok(result.affected.every(x=>x.sourceChannelUrl));
  assert.equal((await fs.readFile(path.join(resolved,'errors.jsonl'),'utf8')).includes('fetch failed'),true);
}));

test('Refuses conflicting markers instead of revisiting an unknown channel',async()=>withRoot(async root=>{
  const folder=path.join(root,'category','channel');
  await jsonl(path.join(folder,'errors.jsonl'),[{sourcePath:A,error:'fetch failed'}]);
  await fs.writeFile(path.join(folder,'.source_channel.json'),JSON.stringify({sourceChannelUrl:'https://discord.com/channels/12345678901234567/98765432109876543'}));
  await fs.writeFile(path.join(folder,'scan_report.json'),JSON.stringify({channelUrl:'https://discord.com/channels/12345678901234567/88888888888888888'}));
  const result=await inventoryFailedArchives(root);
  assert.equal(result.affected.length,1);
  assert.equal(result.affected[0].sourceChannelUrl,null);
  assert.match(result.affected[0].issue,/Conflicting/);
}));

test('Retry allowlist downloads only failed path; original scan report stays unchanged',async()=>withRoot(async root=>{
  const oldFetch=global.fetch;
  global.fetch=async u=>{const response=new Response(Buffer.from('some fake image data'),{status:200,headers:{'Content-Type':'image/png'}});Object.defineProperty(response,'url',{value:u});return response;};
  try{
    const archive=new ChannelArchive(root,100,new Set([A]));
    await archive.init();
    await archive.process([{id:'42',media:[{url:url(A)},{url:url(B)}],links:[]}]);
    assert.equal(archive.stats.saved,1);
    const rows=await fs.readFile(path.join(root,'download_manifest.jsonl'),'utf8');
    assert.match(rows,/first.png/);assert.doesNotMatch(rows,/second.mov/);
    await fs.writeFile(path.join(root,'scan_report.json'),'ORIGINAL CONTENT');
    await archive.finish({stopReason:'test'},'retry_scan_report.json');
    assert.equal(await fs.readFile(path.join(root,'scan_report.json'),'utf8'),'ORIGINAL CONTENT');
  } finally {global.fetch=oldFetch;}
}));
