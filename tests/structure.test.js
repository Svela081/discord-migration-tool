'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {categoryStructurePlan,applyStructurePlan,destinationHasMessages}=require('../src/bot-uploader');
const S=['photos','bella'].map((sourceChannelName,i)=>({sourceChannelName,sourceChannelId:String(i+1)}));
const G='111111111111111111',C='222222222222222222';
const category={id:C,type:4,name:'Sample Archive'};
const ch=(id,name,parent=C,type=0)=>({id,name,parent_id:parent,type});

test('option A reuses exact category/channel and creates only missing channel irrespective of order',()=>{
  const p=categoryStructurePlan(S,[ch('999','else','333333333333333333'),ch('444','photos'),category],'Sample Archive');
  assert.equal(p.categoryStatus,'reuse');
  assert.deepEqual(p.channels.map(r=>r.status),['reuse','create']);
  assert.equal(p.channels[0].target.id,'444');
  assert.equal(p.safe,true);
});
test('option A does not reuse same-name channels in unrelated categories',()=>{
  const p=categoryStructurePlan(S,[category,ch('555','photos','333333333333333333')],'Sample Archive');
  assert.deepEqual(p.channels.map(r=>r.status),['create','create']);
});
test('option A fails closed on duplicate categories, ambiguous channels or wrong type',()=>{
  assert.throws(()=>categoryStructurePlan(S,[category,{id:'333',type:4,name:'sample archive'}],'Sample Archive'),/Multiple destination categories/);
  const ambiguous=categoryStructurePlan(S,[category,ch('444','photos'),ch('555','photos')],'Sample Archive');
  assert.equal(ambiguous.channels[0].status,'ambiguous');assert.equal(ambiguous.safe,false);
  const wrong=categoryStructurePlan(S,[category,ch('444','photos',C,2)],'Sample Archive');
  assert.equal(wrong.channels[0].status,'wrong-type');assert.equal(wrong.safe,false);
  assert.throws(()=>categoryStructurePlan(S,[category],'Wrong',{categoryId:C}),/named/);
  assert.throws(()=>categoryStructurePlan(S,[category],'Sample Archive',{categoryId:'invalid'}),/not found/);
});
test('option A detects duplicate names in source batch',()=>{
  const p=categoryStructurePlan([{sourceChannelName:'photos'},{sourceChannelName:'PHOTOS'}],[category],'Sample Archive');
  assert.equal(p.safe,false);
  assert.deepEqual(p.channels.map(r=>r.status),['duplicate-source','duplicate-source']);
});
test('option A creates new category, then text channels, checking official API state each time',async()=>{
  const original=global.fetch;
  let all=[];const created=[];
  global.fetch=async (url,opts)=>{
    const path=String(url);
    assert.match(path,new RegExp(`/guilds/${G}/channels$`));
    if(opts.method==='GET')return Response.json(all);
    if(opts.method==='POST'){
      const body=JSON.parse(opts.body);created.push(body);
      const result={id:body.type===4?C:String(333333333333333333n+BigInt(created.length)),type:body.type,
        name:body.name,parent_id:body.parent_id||null};
      all.push(result);return Response.json(result);
    }
    throw new Error('Unexpected method');
  };
  try{
    const out=await applyStructurePlan('dummy',G,S,'Sample Archive',{logger:{log(){}}});
    assert.equal(out.created.categories.length,1);
    assert.equal(out.created.channels.length,2);
    assert.deepEqual(created.map(x=>x.type),[4,0,0]);
    assert.equal(created[1].parent_id,C);
    assert.equal(out.channels.length,2);
  }finally{global.fetch=original;}
});
test('option A reuses existing category/channel and creates only the missing one',async()=>{
  const original=global.fetch;
  let all=[category,ch('555555555555555555','photos')];const created=[];
  global.fetch=async(url,opts)=>{
    if(opts.method==='GET')return Response.json(all);
    if(opts.method==='POST'){
      const body=JSON.parse(opts.body);created.push(body);
      const r={id:'666666666666666666',...body};all.push(r);return Response.json(r);
    }
    throw Error('unexpected');
  };
  try{
    const r=await applyStructurePlan('dummy',G,S,'Sample Archive',{logger:{log(){}}});
    assert.equal(r.created.categories.length,0);
    assert.equal(r.created.channels.length,1);
    assert.deepEqual(r.channels.map(x=>x.status),['reused','created']);
    assert.equal(r.channels[0].target.id,'555555555555555555');
    assert.equal(created[0].parent_id,C);
  }finally{global.fetch=original;}
});
test('option A refuses any creation when preview becomes ambiguous',async()=>{
  const original=global.fetch;
  let posts=0;
  global.fetch=async(url,opts)=>{
    if(opts.method==='POST'){posts++;throw Error('No POST expected');}
    return Response.json([category,ch('444','photos'),ch('555','photos')]);
  };
  try{
    await assert.rejects(()=>applyStructurePlan('dummy',G,S,'Sample Archive',{logger:{log(){}}}),/Ambiguous/);
    assert.equal(posts,0);
  }finally{global.fetch=original;}
});
test('history probe recognizes existing destination messages',async()=>{
  const original=global.fetch;
  global.fetch=async(url,opts)=>{assert.match(String(url),/\/messages\?limit=1$/);return Response.json([{id:'some-message'}]);};
  try{assert.equal(await destinationHasMessages('dummy',{id:'555'}),true);}finally{global.fetch=original;}
});
test('category capacity fails preview before any channel creation',()=>{
  const many=Array.from({length:50},(_,i)=>ch(String(i+100),'existing'+i));
  const p=categoryStructurePlan(S,[category,...many],'Sample Archive');
  assert.equal(p.capacityOk,false);assert.equal(p.safe,false);
});
