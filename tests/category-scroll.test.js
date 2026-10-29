'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeSidebarSnapshot,combineCandidates}=require('../src/category-scroll');
const SERVER='1111111111111111111';
const CATEGORY='2222222222222222222';
const channel=(n)=>({type:'channel',url:`https://discord.com/channels/${SERVER}/${String(1238500000000000000n+BigInt(n))}`,name:`channel-name-${n}`});
const state=()=>({categoryId:CATEGORY,serverId:SERVER,started:false,finished:false,reason:null,channels:[]});

test('collects a category beyond first 13 virtualized channels and stops at next category',()=>{
  const s=state();
  mergeSidebarSnapshot(s,{entries:[{type:'category',id:CATEGORY,name:'Sample Archive'},...Array.from({length:13},(_,i)=>channel(i))]});
  assert.equal(s.channels.length,13);
  mergeSidebarSnapshot(s,{entries:Array.from({length:20},(_,i)=>channel(i+10))});
  assert.equal(s.channels.length,30);
  mergeSidebarSnapshot(s,{entries:[...Array.from({length:18},(_,i)=>channel(i+30)),{type:'category',id:'999',name:'Other Archive'},channel(48)]});
  assert.equal(s.channels.length,48);
  assert.equal(s.finished,true);
  assert.equal(s.reason,'next-category-heading');
});

test('ignores unrelated channels before chosen heading or after next category',()=>{
  const s=state();
  mergeSidebarSnapshot(s,{entries:[channel(99),{type:'category',id:CATEGORY},channel(0),{type:'category',id:'other'},channel(1)]});
  assert.deepEqual(s.channels.map(c=>c.folder),['channel-name-0']);
});

test('can complete at the bottom of the sidebar if category is the last',()=>{
  const s=state();
  mergeSidebarSnapshot(s,{entries:[{type:'category',id:CATEGORY},channel(1)],atEnd:true});
  assert.equal(s.reason,'sidebar-bottom');
  assert.equal(s.finished,true);
});

test('merging overlapping snapshots preserves earliest real channel names',()=>{
  const rows=[{url:`https://discord.com/channels/${SERVER}/1238500000000000001`,name:'photos'}];
  const a=combineCandidates([],rows,SERVER,CATEGORY);
  const b=combineCandidates(a,[{url:rows[0].url,name:'channel-1238500000000000001'}],SERVER,CATEGORY);
  assert.equal(b.length,1);
  assert.equal(b[0].folder,'photos');
});
