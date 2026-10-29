'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const {matchPlan,archiveSubfolder,migratePair,journalNames,MAX_BOT_FILE_BYTES,destinationCategory}=require('../src/bot-uploader');

test('matches channel names regardless of order, and never guesses duplicate names',()=>{
  const sources=['videos','photos','missing'].map((sourceChannelName,i)=>({sourceChannelName,sourceChannelId:String(i+100)}));
  const targets=[{id:'4',name:'photos'},{id:'1',name:'videos'},{id:'5',name:'photos'}];
  const plan=matchPlan(sources,targets);
  assert.deepEqual(plan.map(p=>p.status),['matched','ambiguous','missing']);
  assert.equal(plan[0].target.id,'1');
  assert.equal(plan[1].target,null);
});
test('rejects unsafe or missing indexed folder paths',()=>{
  assert.throws(()=>archiveSubfolder('/tmp/abc',{archiveFolder:'../../etc'}));
  assert.throws(()=>archiveSubfolder('/tmp/abc',{archiveFolder:''}));
  assert.equal(archiveSubfolder('/tmp/abc',{archiveFolder:'Sample Archive (category)/channel'}),'/tmp/abc/Sample Archive (category)/channel');
});
test('bot preview detects exact destination parent category from API, not name alone',async()=>{
  const original=global.fetch;
  const calls=[];
  global.fetch=async(url)=>{
    calls.push(String(url));
    if(String(url).endsWith('/channels/111111111111111111'))
      return new Response(JSON.stringify({id:'111111111111111111',guild_id:'222222222222222222',parent_id:'333333333333333333',type:0}),{status:200});
    return new Response(JSON.stringify([{type:4,id:'333333333333333333',name:'Sample Archive'},
      {type:0,name:'photos',id:'444444444444444444',parent_id:'333333333333333333'},
      {type:0,name:'photos',id:'555555555555555555',parent_id:'666666666666666666'}]),{status:200});
  };
  try{
    const r=await destinationCategory('DUMMY','https://discord.com/channels/222222222222222222/111111111111111111');
    assert.equal(r.categoryId,'333333333333333333');
    assert.equal(r.channels.length,1);
    assert.equal(r.channels[0].id,'444444444444444444');
    assert.equal(calls.length,2);
  }finally{global.fetch=original;}
});
test('bot upload journal resumes links without duplicate posts and reports large videos',async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dmt-v120-'));
  const folder=path.join(base,'category','videos');
  await fs.mkdir(path.join(folder,'Videos'),{recursive:true});
  const large=path.join(folder,'Videos','big.mov');
  const file=await fs.open(large,'w');await file.truncate(MAX_BOT_FILE_BYTES+1);await file.close();
  await fs.writeFile(path.join(folder,'download_manifest.jsonl'), JSON.stringify({file:'Videos/big.mov',messageId:'3333333333333333333',sourcePath:'/attachments/big.mov'})+'\n');
  await fs.writeFile(path.join(folder,'embeds.jsonl'),JSON.stringify({messageId:'777777777777777771',url:'https://mega.nz/file/xyz#key',label:'archive'})+'\n');
  const source={sourceChannelId:'999999999999999999',sourceChannelName:'videos',archiveFolder:'category/videos'};
  const target={id:'888888888888888888'};
  const original=global.fetch;
  let posted=0;
  global.fetch=async(url,options)=>{assert.equal(options.method,'POST');posted++;
    const body=JSON.parse(options.body);assert.deepEqual(body.allowed_mentions,{parse:[]});
    return new Response(JSON.stringify({id:'777777777777777777',channel_id:target.id}),{status:200});};
  try{
    const one=await migratePair('dummy',base,source,target,{logger:{log(){},warn(){},error(){}}});
    assert.equal(one.posted,1);assert.equal(one.oversized.length,1);assert.equal(posted,1);
    const two=await migratePair('dummy',base,source,target,{logger:{log(){},warn(){},error(){}}});
    assert.equal(two.posted,0);assert.equal(two.alreadyPosted,1);assert.equal(two.oversized.length,1);assert.equal(posted,1);
    const journal=await fs.readFile(journalNames(base,source,target).journal,'utf8');
    assert.match(journal,/777777777777777777/);
  }finally{global.fetch=original;await fs.rm(base,{recursive:true,force:true});}
});
test('uncertain network outcome leaves pending marker and prevents automatic replay',async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'dmt-v120-'));
  const folder=path.join(base,'category','videos');await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'embeds.jsonl'),JSON.stringify({messageId:'777777777777777771',url:'https://mega.nz/file/x#k'})+'\n');
  const src={sourceChannelId:'999999999999999999',sourceChannelName:'videos',archiveFolder:'category/videos'},tgt={id:'888888888888888888'};
  const original=global.fetch;
  global.fetch=async()=>{throw Error('connection reset');};
  try{
    await assert.rejects(()=>migratePair('dummy',base,src,tgt,{logger:{log(){},warn(){},error(){}}}),/Network outcome uncertain/);
    assert.ok(JSON.parse(await fs.readFile(journalNames(base,src,tgt).pending,'utf8')).key);
    await assert.rejects(()=>migratePair('dummy',base,src,tgt,{logger:{log(){},warn(){},error(){}}}),/Unverified prior upload/);
  }finally{global.fetch=original;await fs.rm(base,{recursive:true,force:true});}
});
