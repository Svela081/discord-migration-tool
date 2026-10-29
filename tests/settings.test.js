'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {readSettings,saveSettings}=require('../src/settings');

async function withDirectory(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'migration-settings-'));
  try{return await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('saved choices survive a restart without persisting credentials or unknown fields',async()=>withDirectory(async dir=>{
  const settings={outputRoot:'~/Documents/Discord Migration Tool',destinationServerId:'111111111111111111',
    destinationCategories:{'222222222222222222:333333333333333333':
      {serverId:'111111111111111111',categoryId:'444444444444444444',categoryName:'Sample Archive',token:'discard'}},
    token:'discard',DISCORD_BOT_TOKEN:'discard',unrelated:'discard'};
  await saveSettings(dir,settings);
  const text=await fs.readFile(path.join(dir,'config.json'),'utf8');
  assert.doesNotMatch(text,/discard|token|unrelated/i);
  const loaded=await readSettings(dir);
  assert.equal(loaded.destinationServerId,settings.destinationServerId);
  assert.equal(loaded.destinationCategories['222222222222222222:333333333333333333'].categoryName,'Sample Archive');
}));
test('missing settings use defaults; malformed or numerically rounded server IDs fail clearly',async()=>withDirectory(async dir=>{
  assert.deepEqual(await readSettings(dir),{});
  await fs.writeFile(path.join(dir,'config.json'),'{bad json');
  await assert.rejects(()=>readSettings(dir),SyntaxError);
  await assert.rejects(()=>saveSettings(dir,{destinationServerId:111111111111111111}),/quotes/);
}));
test('project .env loads automatically while an explicit shell token takes precedence',async()=>withDirectory(async dir=>{
  await fs.writeFile(path.join(dir,'.env'),'DISCORD_BOT_TOKEN=fake-test-value\n');
  const modulePath=path.resolve(__dirname,'../src/settings.js');
  const script='require(process.argv[1]).loadLocalEnv(process.argv[2]); process.stdout.write(process.env.DISCORD_BOT_TOKEN || "");';
  const env={...process.env};delete env.DISCORD_BOT_TOKEN;
  const loaded=spawnSync(process.execPath,['-e',script,modulePath,dir],{env,encoding:'utf8'});
  assert.equal(loaded.status,0);assert.equal(loaded.stdout,'fake-test-value');
  const shell=spawnSync(process.execPath,['-e',script,modulePath,dir],{env:{...env,DISCORD_BOT_TOKEN:'explicit-shell-value'},encoding:'utf8'});
  assert.equal(shell.status,0);assert.equal(shell.stdout,'explicit-shell-value');
}));
