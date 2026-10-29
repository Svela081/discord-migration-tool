'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {chooseDestination}=require('../src/destination');
const G='111111111111111111',C='222222222222222222',A='333333333333333333',B='444444444444444444';
const category={sourceServerId:A,sourceCategoryId:B,sourceCategoryName:'Sample Archive'};
function cliFor(answers){return {prompts:[],async question(prompt){this.prompts.push(prompt);assert.ok(answers.length,'unexpected extra prompt');return answers.shift();}};}
function apiFor(rows=[{id:C,type:4,name:'Sample Archive'}]){
  return {async guildChannels(token,id){assert.equal(id,G);return rows;},async destinationCategory(token,url){assert.equal(url,`https://discord.com/channels/${G}/${A}`);return {guildId:G,categoryId:C,categoryName:'Sample Archive'};}};
}
test('one destination channel URL supplies server, category ID and category name without extra ID prompts',async()=>{
  const cli=cliFor([`https://discord.com/channels/${G}/${A}`]);
  const result=await chooseDestination(cli,'dummy',category,{},apiFor());
  assert.equal(result.guildId,G);assert.equal(result.specificId,C);assert.equal(result.targetName,'Sample Archive');
  assert.equal(cli.prompts.length,1);
});
test('server ID supports creating a missing category without requesting a nonexistent channel ID',async()=>{
  const cli=cliFor([G,'New Archive']);
  const result=await chooseDestination(cli,'dummy',category,{},apiFor([]));
  assert.equal(result.targetName,'New Archive');assert.equal(result.specificId,null);assert.equal(cli.prompts.length,2);
});
test('duplicate category names require choosing a listed exact ID',async()=>{
  const cli=cliFor([G,'',B]);
  const rows=[{id:C,type:4,name:'Sample Archive'},{id:B,type:4,name:'sample archive'}];
  const result=await chooseDestination(cli,'dummy',category,{},apiFor(rows));
  assert.equal(result.specificId,B);
  await assert.rejects(()=>chooseDestination(cliFor([G,'',A]),'dummy',category,{},apiFor(rows)),/listed/);
});
test('a saved mapping can be reused with Enter after resolving its current API category',async()=>{
  const cli=cliFor(['']);
  const settings={destinationCategories:{[`${A}:${B}`]:{serverId:G,categoryId:C,categoryName:'Old name'}}};
  const api=apiFor();api.destinationCategory=async(token,url)=>{
    assert.equal(url,`https://discord.com/channels/${G}/${C}`);
    return {guildId:G,categoryId:C,categoryName:'Current name'};
  };
  const result=await chooseDestination(cli,'dummy',category,settings,api);
  assert.equal(result.targetName,'Current name');assert.match(cli.prompts[0],new RegExp(C));
});
test('unknown guild explains the server-versus-category ID mix-up and rejects foreign URLs',async()=>{
  const api=apiFor();api.guildChannels=async()=>{throw new Error('Discord API GET: HTTP 404');};
  await assert.rejects(()=>chooseDestination(cliFor([G]),'dummy',category,{},api),/SERVER ID/);
  await assert.rejects(()=>chooseDestination(cliFor(['https://example.com/channels/1/2']),'dummy',category,{},api),/full destination/);
});
