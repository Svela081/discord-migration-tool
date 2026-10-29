'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');

async function runMenu(project,steps){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(project,'index.js')],{cwd:project,
      env:{...process.env,DISCORD_BOT_TOKEN:''},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',buffer='',next=0;
    const timer=setTimeout(()=>{child.kill();reject(new Error('CLI prompt timeout: '+stdout));},20000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.stdout.on('data',chunk=>{
      stdout+=chunk;buffer+=chunk;
      while(next<steps.length){
        const [prompt,answer]=steps[next];const at=buffer.indexOf(prompt);
        if(at<0)break;
        buffer=buffer.slice(at+prompt.length);next++;child.stdin.write(answer+'\n');
      }
    });
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,answered:next});});
  });
}
test('offline reports return to the menu and ask for the archive root once, without loading a browser',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'migration-cli-'));
  try{
    const project=path.join(dir,'project'),archive=path.join(dir,'archive');
    await fs.mkdir(project);
    for(const file of ['index.js','package.json','src'])
      await fs.cp(path.join(__dirname,'..',file),path.join(project,file),{recursive:true});
    await fs.writeFile(path.join(project,'config.json'),JSON.stringify({outputRoot:archive}));
    const result=await runMenu(project,[['Choose [1]:','4'],['Archive root [',''],['Choose [1]:','4'],['Choose [1]:','0']]);
    assert.equal(result.code,0);assert.equal(result.answered,4);assert.equal(result.stderr,'');
    assert.equal((result.stdout.match(/Archive root \[/g)||[]).length,1);
    assert.equal((result.stdout.match(/=== OVERSIZED FILES:/g)||[]).length,2);
    assert.doesNotMatch(result.stdout,/Launching Chrome/);
    const saved=JSON.parse(await fs.readFile(path.join(project,'config.json'),'utf8'));
    assert.equal(saved.outputRoot,archive);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a setup error returns to the menu so the session can exit cleanly',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'migration-cli-error-'));
  try{
    for(const file of ['index.js','package.json','src'])
      await fs.cp(path.join(__dirname,'..',file),path.join(dir,file),{recursive:true});
    await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({outputRoot:path.join(dir,'archive')}));
    const result=await runMenu(dir,[['Choose [1]:','3'],['Archive root [',''],['Choose [1]:','0']]);
    assert.equal(result.code,0);assert.equal(result.answered,3);
    assert.match(result.stderr,/DISCORD_BOT_TOKEN/);assert.doesNotMatch(result.stdout,/Launching Chrome/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('separate single-channel tasks share one download browser and close it on exit',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'migration-browser-session-'));
  try{
    for(const file of ['index.js','package.json','src'])
      await fs.cp(path.join(__dirname,'..',file),path.join(dir,file),{recursive:true});
    await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({outputRoot:path.join(dir,'archive')}));
    const stub=path.join(dir,'node_modules','playwright-core');
    await fs.mkdir(stub,{recursive:true});
    await fs.writeFile(path.join(stub,'index.js'),`module.exports={chromium:{async launchPersistentContext(){
      console.log('TEST_BROWSER_OPEN');
      const page={async goto(){},setDefaultTimeout(){},async evaluate(){return [];}};
      return {pages(){return [page];},on(event,callback){this.closed=callback;},async close(){console.log('TEST_BROWSER_CLOSE');this.closed();}};
    }}};`);
    const channel=id=>`https://discord.com/channels/111111111111111111/${id}`;
    const sourceSteps=id=>[['SOURCE channel URL:',channel(id)],['Optional parent category folder',''],
      ['Type DOWNLOAD to continue:','DOWNLOAD'],['Once messages appear, press Enter','']];
    const result=await runMenu(dir,[['Choose [1]:','2'],['Archive root [',''],
      ['When signed in and source server is visible, press Enter',''],...sourceSteps('222222222222222222'),
      ['Choose [1]:','2'],...sourceSteps('333333333333333333'),['Choose [1]:','0']]);
    assert.equal(result.code,0);assert.equal(result.stderr,'');
    assert.equal((result.stdout.match(/TEST_BROWSER_OPEN/g)||[]).length,1);
    assert.equal((result.stdout.match(/TEST_BROWSER_CLOSE/g)||[]).length,1);
    assert.equal((result.stdout.match(/Archive root \[/g)||[]).length,1);
    assert.equal((result.stdout.match(/Skipping: Discord message elements/g)||[]).length,2);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
