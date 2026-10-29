#!/usr/bin/env node
'use strict';
// Discord Migration Tool: source archiving + official bot-based import.
// Never automates message posting through a personal Discord account.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const readline=require('node:readline/promises');
const {stdin:input,stdout:output}=require('node:process');
const {expandHome,channelId,cleanName,outputFolder}=require('./src/utils');
const {channelNameFromPage,captureVisible,moveToBottom,scrollOlder,readScrollState}=require('./src/capture');
const {ChannelArchive}=require('./src/archive');
const {resolveChannelInput,makeSingleChannelConfig}=require('./src/source');
const {ScanProgress}=require('./src/scan-progress');
const {discoverCategory,parseChannelReferences,expandCategoryInSidebar}=require('./src/discovery');
const {discoverCategoryByScrolling}=require('./src/category-scroll');
const {selectThroughChannel}=require('./src/source-boundary');
const {recordChannel,writeChannelMarker,atomicJson,readCatalog}=require('./src/archive-index');
const {categoryStructurePlan,guildChannels,applyStructurePlan,migratePair}=require('./src/bot-uploader');
const {reconcilePair,fetchCompleteHistory,historyFingerprint}=require('./src/reconcile');
const {collectOversized,writeOversizedReport}=require('./src/oversized-report');
const {inventoryFailedArchives}=require('./src/retry-failed');
const {loadLocalEnv,readSettings,saveSettings,categoryKey}=require('./src/settings');
const {chooseDestination}=require('./src/destination');
const {version:VERSION}=require('./package.json');

const DEFAULT_ARCHIVE='~/Documents/Discord Migration Tool';
let interrupted=false;
function pause(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function askInterface(){return readline.createInterface({input,output});}

async function archiveChannel(page, cli, config, folderOwners) {
  const channel = config.channels[0];
  console.log(`\n=== Archiving ${channel.url} ===`);
  await page.goto(channel.url, {waitUntil:'domcontentloaded', timeout:60_000});
  await pause(3000);
  let visible = await captureVisible(page);
  if (!visible.length) {
    console.log('No messages detected yet. Check Chrome for login or verification prompts.');
    await cli.question('Once messages appear, press Enter to retry (or Control+C to stop)... ');
    if (interrupted) return;
    visible = await captureVisible(page);
    if (!visible.length) {
      console.log('Skipping: Discord message elements could not be detected.');
      return;
    }
  }
  if (!channel.folder || channel.autoName) {
    const detected = cleanName(await channelNameFromPage(page, channelId(channel.url).channel), '');
    if (detected) channel.folder = detected;
    else if (!channel.folder || /^channel-\d+$/.test(channel.folder)) {
      console.log('Could not detect the actual channel name.');
      const actual = (await cli.question('Type the name you see in Discord (Enter to skip): ')).trim();
      if (!actual) { console.log('Skipping to avoid incorrect folder naming.'); return; }
      channel.folder = cleanName(actual);
    }
  }
  let folder = outputFolder(config.outputRoot, channel);
  if (config.retryTargetFolder) {
    const root=path.resolve(expandHome(config.outputRoot));
    const proposed=path.resolve(config.retryTargetFolder);
    if (!proposed.startsWith(root+path.sep))throw new Error('Retry target must remain within the chosen archive root');
    const expected=channelId(channel.url);
    const actualPage=channelId(page.url());
    if (!actualPage || expected.guild!==actualPage.guild || expected.channel!==actualPage.channel)
      throw new Error('Source channel navigation did not resolve to the expected original channel');
    folder=proposed;
  }
  const actualId = channelId(channel.url).channel;
  const existingOwner = folderOwners.get(folder);
  if (existingOwner && existingOwner !== channel.url) {
    channel.folder = `${channel.folder}__${actualId}`;
    folder = outputFolder(config.outputRoot, channel);
    console.log('Same-name channel already processed this session; added ID to avoid mixing files.');
  }
  folderOwners.set(folder, channel.url);
  await writeChannelMarker(folder, channel);
  console.log(`Saving #${channel.folder} → ${folder}`);
  const archive = new ChannelArchive(folder, config.maxFileMB, config.retryOnlyPaths);
  await archive.init();

  // Discord usually opens at latest; jump down only if it remembered a prior
  // position. From there, traverse older history once—never return back down.
  await moveToBottom(page);
  await pause(config.scrollDelayMs);
  const messageIds = new Set();
  const progress = new ScanProgress();
  const remember = rows => {
    let count = 0;
    for (const row of rows) {
      if (!messageIds.has(row.id)) {messageIds.add(row.id); count++;}
    }
    return count;
  };
  let stopReason = null;
  let steps = 0;
  while (!interrupted && steps < config.maxScrolls) {
    steps++;
    visible = await captureVisible(page);
    let discovered = remember(visible);
    await archive.process(visible);
    // If the welcome-to-channel banner is visible, the oldest boundary has
    // already been reached. No additional scroll attempts are necessary.
    const beforeScroll = await readScrollState(page);
    if (beforeScroll.welcomeVisible) {
      stopReason = 'channel-welcome-banner';
      console.log(`  Reached the channel welcome banner (${steps - 1} scroll movements).`);
      break;
    }
    const movement = await scrollOlder(page);
    if (!movement.found) {
      stopReason = 'message-scroller-not-found';
      console.log('Message scroller not found; currently visible media was saved.');
      break;
    }
    // Keep waiting for ordinary Discord message rendering. The tool does not
    // attempt to hide that it is automated or evade platform rate limits.
    await pause(config.scrollDelayMs);
    const afterScroll = await captureVisible(page);
    discovered += remember(afterScroll);
    await archive.process(afterScroll);
    const settledPosition = await readScrollState(page);
    stopReason = progress.observe(discovered, movement, settledPosition);
    if (steps % 5 === 0) {
      console.log(`  ${steps} scroll steps, ${messageIds.size} message IDs, ${archive.stats.saved} downloaded, ${archive.links.size} links${settledPosition.top ? ' (at oldest boundary)' : ''}`);
    }
    if (stopReason) {
      console.log(`  History scan stopped: ${stopReason} (${steps} steps).`);
      break;
    }
  }
  if (!interrupted) {
    const finalVisible = await captureVisible(page);
    remember(finalVisible);
    await archive.process(finalVisible);
  }
  const report = {
    channelUrl:channel.url, folder, scannedAt:new Date().toISOString(),
    uniqueVisibleMessages:messageIds.size, scrollSteps:steps,
    stopReason:stopReason || (interrupted ? 'interrupted' : 'max-scroll-limit'),
    reachedStableTop:stopReason === 'stable-oldest-message-boundary',
    welcomeBannerDetected:stopReason === 'channel-welcome-banner',
    reachedBeginning:stopReason === 'channel-welcome-banner' || stopReason === 'stable-oldest-message-boundary',
    noScrollerFound:stopReason === 'message-scroller-not-found',
    interrupted, hitMaxScrollLimit:steps >= config.maxScrolls && !stopReason,
    note:'Best-effort browser DOM scan. The welcome banner is strong evidence of reaching the channel beginning, but inaccessible/deleted media, slow loading, and UI changes can still cause omissions.'
  };
  await archive.finish(report, config.retryOnlyPaths ? 'retry_scan_report.json' : 'scan_report.json');
  console.log(`Done: ${archive.stats.saved} downloaded, ${archive.links.size} external links, ${archive.stats.failed} failed.`);
  if (report.welcomeBannerDetected) console.log('Reached the channel welcome banner (beginning of visible history).');
  else if (report.reachedStableTop) console.log('Reached the apparent oldest boundary. Verify the archive if completeness matters.');
  else console.log('History may be incomplete. Review scan_report.json and compare the oldest messages in Discord.');
  return {folder, report, stats:archive.stats};
}

async function chooseArchive(cli){
  console.log(`\n=== Discord Migration Tool v${VERSION} ===`);
  console.log('1 — Download a source category range');
  console.log('2 — Download one source channel');
  console.log('3 — Import saved archives with an official bot');
  console.log('4 — Export oversized-file report (offline)');
  console.log('5 — Repair failed image/video downloads');
  console.log('0 — Exit');
  const raw=(await cli.question('Choose [1]: ')).trim()||'1';
  if(!['0','1','2','3','4','5'].includes(raw))throw new Error('Choose 0, 1, 2, 3, 4, or 5.');
  return raw;
}
async function chooseRoot(cli,settings){
  const defaultRoot=settings.outputRoot||DEFAULT_ARCHIVE;
  const raw=(await cli.question(`Archive root [${defaultRoot}]: `)).trim();
  const root=path.resolve(expandHome(raw||defaultRoot));
  settings.outputRoot=root;
  await saveSettings(__dirname,settings);
  console.log(`Local archive: ${expandHome(root)}`);
  return root;
}
async function getCategoryRequest(page,cli,root){
  console.log('\nSOURCE CATEGORY: enter FIRST and LAST source channel URLs (both included).');
  const seedUrl=resolveChannelInput((await cli.question('FIRST SOURCE channel URL (start): ')).trim(),'');
  const endUrl=resolveChannelInput((await cli.question('LAST SOURCE channel URL (stop): ')).trim(),'');
  const serverId=channelId(seedUrl).guild;
  if(channelId(endUrl).guild!==serverId)throw new Error('First and last URLs belong to different servers.');
  const catalogForIds=await readCatalog(root);
  const known=catalogForIds.categories.find(c=>c.sourceServerId===serverId && c.channels?.some(ch=>ch.sourceChannelId===channelId(seedUrl).channel));
  const typedCategory=(await cli.question(`SOURCE parent category ID${known?' [Enter to reuse '+known.sourceCategoryId+']':''}: `)).trim();
  const categoryId=typedCategory||known?.sourceCategoryId;
  if(!/^\d{15,22}$/.test(categoryId||''))throw new Error('A source parent category ID is required for a new category to keep the archive correctly organized.');
  await page.goto(seedUrl,{waitUntil:'domcontentloaded',timeout:60000});
  await pause(2500);
  await expandCategoryInSidebar(page,categoryId).catch(()=>{});
  await pause(800);
  const initial=await discoverCategory(page,categoryId,serverId);
  console.log(`Found ${initial.channels.length} channels in the initial source sidebar snapshot.`);
  console.log('Scanning the source server sidebar; virtualized lists may include other categories...');
  const scanned=await discoverCategoryByScrolling(page,categoryId,serverId,{
    categoryName:initial.categoryName,initialChannels:initial.channels,logger:console});
  const all=scanned.channels;
  console.log(`Discovered ${all.length} distinct sidebar channels (${scanned.reason}).`);
  if(!scanned.complete)console.warn('WARNING: source sidebar scan may be incomplete.');
  if(!all.length)throw new Error('No source channels found. Expand the source category in Chrome and retry.');
  const first=channelId(seedUrl).channel;
  if(!all.some(ch=>ch.id===first))throw new Error('Seed source channel was not found; check the category and sidebar.');
  console.log('\nSOURCE SIDEBAR PREVIEW (MAY INCLUDE OTHER CATEGORIES):');
  all.slice(0,65).forEach((ch,i)=>console.log(`  ${i+1}. #${ch.folder} (${ch.id})`));
  if(all.length>65)console.log(`  ...plus ${all.length-65} additional channels`);
  console.log('IMPORTANT: verify the FIRST and LAST source channels in the discovered sidebar.');
  const lastId=channelId(endUrl).channel;
  const selected=selectThroughChannel(all,first,lastId);
  console.log(`\nCATEGORY LIMIT: ${selected.length} channel(s), starting #${selected[0].folder} and ending #${selected.at(-1).folder} (${lastId})`);
  const after=all.findIndex(ch=>ch.id===lastId)+1;
  if(all[after])console.log(`Next channel #${all[after].folder} (${all[after].id}) is EXCLUDED.`);
  // Deliberately do not request ID confirmations or extra IDs once exact URLs are given.
  const selectedMap=new Map(selected.map(ch=>[ch.id,ch]));
  const categoryName=cleanName(initial.categoryName,'category-'+categoryId);
  const defaultFolder=categoryName;
  const existing=(await readCatalog(root)).categories.find(c=>c.sourceServerId===serverId && c.sourceCategoryId===categoryId);
  const defaultArchiveFolder=existing?.archiveCategoryFolder||defaultFolder;
  const folderRaw=(await cli.question(`Source category ARCHIVE folder name [${defaultArchiveFolder}]: `)).trim();
  const archiveFolder=cleanName(folderRaw||defaultArchiveFolder);
  // Never silently combine two distinct categories into a single directory.
  const catalog=await readCatalog(root);
  const conflicting=catalog.categories.find(c=>c.archiveCategoryFolder===archiveFolder &&
    (c.sourceServerId!==serverId||c.sourceCategoryId!==categoryId));
  if(conflicting)throw new Error(`Folder ${archiveFolder} is already indexed under another category. Choose a different name.`);
  return {serverId,categoryId,categoryName,archiveFolder,channels:[...selectedMap.values()]};
}
async function verifyMissingNames(page,cli,category){
  for(const ch of category.channels){
    if(interrupted)break;
    if(!/^channel-\d+$/.test(ch.folder))continue;
    await page.goto(ch.url,{waitUntil:'domcontentloaded',timeout:60000});
    await pause(1800);
    const actual=channelId(page.url());
    if(actual?.guild!==category.serverId || actual.channel!==ch.id)
      throw new Error(`Could not verify source channel ${ch.id}; not archiving under a guessed name.`);
    let name=cleanName(await channelNameFromPage(page,ch.id),'');
    if(/^channel-\d+$/.test(name)||name===ch.id)name='';
    if(!name)name=cleanName((await cli.question(`Name of source channel ${ch.id} (Enter = skip): `)).trim(),'');
    if(!name){ch.skip=true;console.log(`Skipping unrecognized channel ID ${ch.id}`);}else ch.folder=name;
  }
  category.channels=category.channels.filter(ch=>!ch.skip);
  return category;
}
async function runCategory(page,cli,root){
  const category=await verifyMissingNames(page,cli,await getCategoryRequest(page,cli,root));
  if(interrupted||!category.channels.length)return;
  console.log(`\nARCHIVE PLAN: ${category.channels.length} channel(s) into ${category.archiveFolder}/`);
  for(const [i,ch] of category.channels.entries())console.log(`  ${i+1}. #${ch.folder} (${ch.id})`);
  console.log('Local download ONLY. No destination-server interaction and no posting.');
  const approval=(await cli.question('Type DOWNLOAD to begin (anything else cancels): ')).trim();
  if(approval!=='DOWNLOAD'){console.log('Cancelled.');return;}
  const folderOwners=new Map();
  const summaries=[];
  for(const [i,ch] of category.channels.entries()){
    if(interrupted)break;
    console.log(`\n=== Source archive ${i+1}/${category.channels.length}: #${ch.folder} ===`);
    const config=makeSingleChannelConfig({},ch.url,root);
    config.channels[0].category=category.archiveFolder;
    config.channels[0].folder=ch.folder;
    config.channels[0].autoName=false;
    // Local download allowance is not tied to Discord's upload limits.
    config.maxFileMB=4096;
    config.scrollDelayMs=2500;
    config.maxScrolls=800;
    let result;
    try{
      result=await archiveChannel(page,cli,config,folderOwners);
      if(!result){summaries.push({channel:ch.folder,status:'not-scanned'});continue;}
      const savedName=config.channels[0].folder;
      const row=await recordChannel(root,category,{url:ch.url,folder:savedName},result);
      summaries.push({channel:ch.folder,status:row.status,newMedia:result.stats.saved,downloadErrors:result.stats.failed});
    }catch(error){
      console.error(`ARCHIVE ERROR for #${ch.folder}: ${error.message}`);
      summaries.push({channel:ch.folder,status:'error',error:error.message});
      if(/belongs to another source channel/.test(error.message))break;
    }
  }
  const reportRoot=path.join(expandHome(root),'.archive-reports');
  const file=path.join(reportRoot,`run-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await atomicJson(file,{version:VERSION,serverId:category.serverId,categoryId:category.categoryId,
    categoryName:category.categoryName,archiveFolder:category.archiveFolder,interrupted,
    selectedCount:category.channels.length,results:summaries});
  console.log('\n=== ARCHIVE SUMMARY ===');
  const done=summaries.filter(r=>r.status==='scanned-to-apparent-beginning').length;
  const incomplete=summaries.filter(r=>r.status!=='scanned-to-apparent-beginning').length;
  console.log(`${done} channel(s) reached an apparent beginning; ${incomplete} incomplete/errored/stopped.`);
  console.log('Scanned-to-beginning is best-effort; the UI may still hide older messages.');
  console.log(`Archive index: ${path.join(expandHome(root),'source_archive_index.json')}`);
  console.log(`Run report: ${file}`);
}
async function runSingle(page,cli,root){
  const url=resolveChannelInput((await cli.question('SOURCE channel URL: ')).trim(),'');
  const categoryRaw=(await cli.question('Optional parent category folder (Enter = loose/legacy): ')).trim();
  const config=makeSingleChannelConfig({},url,root);
  config.channels[0].category=categoryRaw?cleanName(categoryRaw):'';
  config.channels[0].autoName=true;
  config.maxFileMB=4096;config.scrollDelayMs=2500;config.maxScrolls=800;
  console.log('Download only, no posts.');
  const confirmed=(await cli.question('Type DOWNLOAD to continue: ')).trim();
  if(confirmed!=='DOWNLOAD')return;
  const result=await archiveChannel(page,cli,config,new Map());
  if(result){
    console.log(`Saved: ${result.folder}`);
    console.log('Single-channel mode is for legacy/standalone archives. Use Category mode for indexed categories.');
  }
}
async function runBotImport(cli,root,settings){
  const token=process.env.DISCORD_BOT_TOKEN;
  if(!token)throw new Error('Set DISCORD_BOT_TOKEN in this project’s .env file or in your shell. See .env.example.');
  const catalog=await readCatalog(root);
  const categories=catalog.categories.filter(c=>c.channels?.length);
  if(!categories.length)throw new Error('No indexed source archives found. Use Mode 1 first.');
  console.log('\n=== OFFICIAL BOT — REUSE EXISTING / CREATE ONLY MISSING ===');
  console.log('Saved archive categories:');
  categories.forEach((c,i)=>console.log(`  ${i+1}. ${c.sourceCategoryName} (${c.channels.length} indexed channels; ${c.archiveCategoryFolder})`));
  const selection=(await cli.question('Source category number [1]: ')).trim()||'1';
  const category=categories[Number(selection)-1];
  if(!category || !/^\d+$/.test(selection))throw new Error('Invalid category selection.');
  console.log('\nIndexed source channels (archive index order):');
  category.channels.forEach((ch,i)=>console.log(`  ${i+1}. #${ch.sourceChannelName} (${ch.sourceChannelId}) [${ch.status}]`));
  const startRaw=(await cli.question('FIRST indexed channel number [1]: ')).trim()||'1';
  const start=Number(startRaw);
  if(!Number.isInteger(start)||start<1||start>category.channels.length)throw new Error('Invalid first indexed channel number');
  const defaultCount=Math.min(5,category.channels.length-start+1);
  const countRaw=(await cli.question(`How many channels to prepare [${defaultCount}]: `)).trim()||String(defaultCount);
  const count=Number(countRaw);
  if(!Number.isInteger(count)||count<1||start-1+count>category.channels.length)throw new Error('Invalid channel count.');
  if(count>10)console.warn('Large batch: review carefully. Official bot permissions and API rate limits still apply.');
  const selected=category.channels.slice(start-1,start-1+count);
  const {guildId,targetName,specificId,rows}=await chooseDestination(cli,token,category,settings);
  const plan=categoryStructurePlan(selected,rows,targetName,{categoryId:specificId||null});
  console.log('\n=== DESTINATION STRUCTURE PREVIEW — NO CHANGES YET ===');
  console.log(`Destination category: "${targetName}" — ${plan.categoryStatus.toUpperCase()}${plan.category?' ('+plan.category.id+')':''}`);
  for(const [i,row] of plan.channels.entries())
    console.log(`${start+i}. #${row.sourceChannelName} — ${row.status.toUpperCase()}${row.target?' ('+row.target.id+')':''}`);
  if(!plan.safe){
    console.error(plan.capacityOk ? 'Ambiguous, duplicate or wrong-type names: nothing has been created. Correct destination or source names first.' : 'Capacity exceeded: Discord permits at most 50 channels per category. No changes made.');
    return;
  }
  const toCreate=plan.channels.filter(r=>r.status==='create').length;
  console.log(`Will reuse ${plan.channels.length-toCreate} text channels and create ${toCreate} missing text channels; ${plan.categoryStatus==='create'?'create a category':'reuse category'}.`);
  console.log('Existing destination channels and messages will NOT be deleted or overwritten.');
  const approval=(await cli.question('Type STRUCTURE to approve only missing category/channel creation (anything else cancels): ')).trim();
  if(approval!=='STRUCTURE'){console.log('Cancelled with no server changes.');return;}
  const applied=await applyStructurePlan(token,guildId,selected,targetName,{categoryId:specificId||null,stop:()=>interrupted});
  settings.destinationServerId=guildId;
  settings.destinationCategories={...settings.destinationCategories,[categoryKey(category)]:
    {serverId:guildId,categoryId:applied.category.id,categoryName:applied.category.name||targetName}};
  await saveSettings(__dirname,settings);
  const reportRoot=path.join(expandHome(root),'.bot-migration-journals');
  const reportFile=path.join(reportRoot,`structure-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await atomicJson(reportFile,{version:VERSION,guildId,categoryName:targetName,
    categoryId:applied.category.id,created:applied.created,
    mappings:applied.channels.map(r=>({sourceChannelId:r.sourceChannelId,sourceChannelName:r.sourceChannelName,
      destinationChannelId:r.target.id,operation:r.status})),at:new Date().toISOString()});
  console.log(`\nStructure prepared. Created ${applied.created.categories.length} categories and ${applied.created.channels.length} channels.`);
  console.log(`Mapping report: ${reportFile}`);
  console.log('\n=== SMART RESUME — READ-ONLY RECONCILIATION ===');
  console.log('Scanning complete destination histories; checking matching filenames, byte sizes and SHA-256 contents.');
  console.log('Large or inaccessible attachments and unresolved pending markers require manual review.');
  const plans=[];
  for(const [i,row] of applied.channels.entries()){
    console.log(`  Comparing ${i+1}/${applied.channels.length}: #${row.sourceChannelName} ...`);
    try{
      const report=await reconcilePair(token,root,row,row.target);
      plans.push({row,report});
      const label=report.hardStop?'BLOCKED':report.uncertain.length?'REVIEW':
        report.missing.length?'PARTIAL':'LOCALLY COMPLETE';
      console.log(`    ${label}: ${report.present.length} present, ${report.missing.length} missing, ${report.uncertain.length} uncertain${report.hardStop?' — '+report.hardStop:''}`);
      if(report.unresolvedArchiveFailures)
        console.log(`    WARNING: ${report.unresolvedArchiveFailures} unresolved SOURCE download failures. Original-source completeness cannot be assured.`);
      if(report.missingLocalManifestFiles)
        console.log(`    WARNING: ${report.missingLocalManifestFiles} manifest-listed local files are absent from disk. Restore/re-download before treating the channel as complete.`);
    }catch(error){
      plans.push({row,error:error.message});
      console.log(`    BLOCKED: ${error.message}`);
    }
    if(interrupted)break;
  }
  const reconcilePath=path.join(reportRoot,`reconcile-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await atomicJson(reconcilePath,{
    version:VERSION,destinationServerId:guildId,destinationCategoryId:applied.category.id,
    generatedAt:new Date().toISOString(),
    channels:plans.map(p=>p.error?{source:p.row.sourceChannelName,destinationId:p.row.target.id,error:p.error}:
      {source:p.row.sourceChannelName,destinationId:p.row.target.id,...p.report})
  });
  console.log(`\nReconciliation report: ${reconcilePath}`);
  const eligible=plans.filter(p=>p.report?.safeToUpload && p.report.missing.length);
  const complete=plans.filter(p=>p.report?.safeToUpload && !p.report.missing.length && !p.report.oversized.length);
  const manual=plans.filter(p=>p.report?.oversized?.length);
  const blocked=plans.filter(p=>!p.report?.safeToUpload);
  console.log(`Locally complete: ${complete.length}; partial with bot-eligible missing items: ${eligible.length}; review/blocked: ${blocked.length}; channels with oversized files: ${manual.length}.`);
  for(const p of manual)for(const f of p.report.oversized)console.log(`  MANUAL >20 MiB #${p.row.sourceChannelName}: ${f.file} (${(f.bytes/1048576).toFixed(1)} MiB)${f.pendingMarker?' [pending marker; retained for review]':''}`);
  for(const p of eligible)console.log(`  #${p.row.sourceChannelName}: ${p.report.missing.length} missing items, ${p.report.present.length} verified present`);
  for(const p of blocked)console.log(`  #${p.row.sourceChannelName}: ${p.error||p.report.hardStop||p.report.uncertain.map(x=>x.reason).join('; ').slice(0,200)}`);
  if(!eligible.length){console.log('Nothing eligible for safe bot upload. Oversized files still require separate manual review. No posts made.');return;}
  console.log('The preview identifies local archive items only; it cannot prove the original source channel was fully downloaded.');
  console.log('The bot limit remains 20 MiB/file. Larger items are NOT sent by this bot; verify destination manually before uploading.');
  const importApproval=(await cli.question('Type MIGRATE to post ONLY verified-missing items from eligible channels (Enter = no uploads): ')).trim();
  if(importApproval!=='MIGRATE'){console.log('No messages posted. Reconciliation report preserved.');return;}
  const results=[];
  for(const [i,p] of eligible.entries()){
    if(interrupted){results.push({status:'interrupted'});break;}
    const {row,report}=p;
    console.log(`\n=== Smart resume ${i+1}/${eligible.length}: #${row.sourceChannelName} ===`);
    try{
      // Prevent posting if someone added/deleted/edited destination messages since preview.
      const latest=await fetchCompleteHistory(token,row.target.id);
      if(historyFingerprint(latest)!==report.fingerprint){
        const message='Destination changed after reconciliation preview. No uploads attempted for this channel.';
        console.warn(message);results.push({source:row.sourceChannelName,status:'skipped',error:message});continue;
      }
      const stats=await migratePair(token,root,row,row.target,{stop:()=>interrupted,
        verifiedPresentKeys:new Set(report.present.map(x=>x.key))});
      results.push(stats);
    }catch(error){
      console.error('UPLOAD STOPPED:',error.message);
      results.push({source:row.sourceChannelName,status:'error',error:error.message});break;
    }
  }
  const importFile=path.join(reportRoot,`import-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  await atomicJson(importFile,{version:VERSION,destinationServerId:guildId,destinationCategoryId:applied.category.id,
    selectedCount:count,eligibleCount:eligible.length,blockedCount:blocked.length,reconciliationReport:reconcilePath,results});
  console.log('\n=== SMART RESUME SUMMARY ===');
  for(const r of results)console.log(`#${r.source||'(interrupted)'}: ${r.posted||0} posted, ${r.alreadyPosted||0} journaled, ${r.alreadyPresent||0} reconciled, ${r.oversized?.length||0} oversized${r.error?' ERROR: '+r.error:''}`);
  console.log(`Import report: ${importFile}`);
}

async function previewRetry(cli,root) {
  const inventory=await inventoryFailedArchives(root);
  console.log(`\n=== FAILED MEDIA INVENTORY ===`);
  console.log(`Found error logs in ${inventory.scannedErrorFolders} channel archive folder(s).`);
  console.log(`${inventory.affected.length} folder(s) contain unresolved failed download(s).`);
  for (const [i,ch] of inventory.affected.entries()) {
    console.log(`  ${i+1}. ${ch.relativeFolder}: ${ch.failedCount} unresolved${ch.issue ? ` — SKIP: ${ch.issue}` : ''}`);
  }
  const targets=inventory.affected.filter(ch=>!ch.issue);
  if (!targets.length) {console.log('No repairable failures. Nothing will be downloaded.');return null;}
  const maxRaw=(await cli.question(`How many affected channels to revisit? [${targets.length}]: `)).trim();
  if(maxRaw && (!/^\d+$/.test(maxRaw)||Number(maxRaw)<1||Number(maxRaw)>targets.length))
    throw new Error('Choose a positive number up to the number of repairable channels.');
  const selected=targets.slice(0,maxRaw ? Number(maxRaw):targets.length);
  console.log(`Will revisit ${selected.length} channel(s), requesting ONLY unresolved media paths.`);
  console.log('Success manifests and previously saved media will be left untouched.');
  const ok=(await cli.question('Type RETRY to begin (anything else cancels): ')).trim();
  return ok==='RETRY'?{inventory,selected}:null;
}
async function runRetry(page,cli,root,plan) {
  const outcomes=[];
  for(const [i,target] of plan.selected.entries()) {
    if(interrupted)break;
    console.log(`\n=== Retry ${i+1}/${plan.selected.length}: ${target.relativeFolder} (${target.unresolved.length} failed media) ===`);
    const config=makeSingleChannelConfig({},target.sourceChannelUrl,root);
    config.maxFileMB=4096;config.scrollDelayMs=2500;config.maxScrolls=800;
    config.retryOnlyPaths=new Set(target.unresolved.map(x=>x.sourcePath));
    config.retryTargetFolder=target.folder;
    // Use exact on-disk folder; never guess a new category/name from Discord's UI.
    const rel=path.relative(path.resolve(expandHome(root)),target.folder);
    const parent=path.dirname(rel);
    config.channels[0].category=parent==='.'?'':parent;
    config.channels[0].folder=path.basename(rel);
    config.channels[0].autoName=false;
    try {
      const outcome=await archiveChannel(page,cli,config,new Map());
      const after=await inventoryFailedArchives(root);
      const remains=after.affected.find(x=>x.folder===target.folder);
      const remaining=remains?.unresolved.length||0;
      outcomes.push({folder:target.relativeFolder,initial:target.unresolved.length,recovered:target.unresolved.length-remaining,remaining,
        retryErrors:outcome?.stats.failed||0,scanStopReason:outcome?.report.stopReason||'not-scanned'});
      console.log(`Recovered: ${target.unresolved.length-remaining}; still missing: ${remaining}`);
    } catch (e) {
      console.warn(`Cannot retry ${target.relativeFolder}: ${e.message}`);
      outcomes.push({folder:target.relativeFolder,initial:target.unresolved.length,recovered:0,remaining:target.unresolved.length,error:e.message});
    }
  }
  const finalInventory=await inventoryFailedArchives(root);
  const reportFolder=path.join(expandHome(root),'.archive-reports');
  const filename=path.join(reportFolder,'retry-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  await atomicJson(filename,{version:VERSION,mode:'retry-failed-downloads',at:new Date().toISOString(),
    interrupted,selectedCount:plan.selected.length,results:outcomes,stillAffected:finalInventory.affected.map(({relativeFolder,sourceChannelUrl,unresolved,issue})=>({relativeFolder,sourceChannelUrl,unresolved,issue}))});
  console.log(`\n=== RETRY SUMMARY ===`);
  for(const row of outcomes)console.log(`  ${row.folder}: ${row.recovered} recovered, ${row.remaining} still missing`);
  console.log(`Report: ${filename}`);
}

async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--version')){console.log(VERSION);return;}
  if(args.includes('--help')){
    console.log(`Discord Migration Tool v${VERSION}\n\nnpm start       Open the task menu\nnpm test        Run offline tests\nnode index.js --version\n\n1 Download category range | 2 Download channel | 3 Bot import\n4 Oversized report (offline) | 5 Repair failed downloads | 0 Exit\n\nOptional local files: .env (bot token), config.json (saved choices).\nSee README.md for setup and docs/UPGRADING.md for existing archives.`);
    return;
  }
  if(args.length)throw new Error('Unknown argument. Use --help or npm start.');
  loadLocalEnv(__dirname);
  const settings=await readSettings(__dirname);
  const cli=askInterface();let context,page,root;
  try{
    while(!interrupted){
      try{
        const mode=await chooseArchive(cli);
        if(mode==='0')break;
        if(!root)root=await chooseRoot(cli,settings);
        if(mode==='3'){await runBotImport(cli,root,settings);continue;}
        if(mode==='4'){
          const result=await collectOversized(root);
          const paths=await writeOversizedReport(root,result);
          console.log(`\n=== OVERSIZED FILES: ${result.oversizedFiles} FILE(S), ${result.affectedChannels} CHANNEL(S) ===`);
          for(const ch of result.channels){
            console.log(`\n${ch.category} / #${ch.sourceChannelName}${ch.indexed?'':' [UNINDEXED / legacy]'}`);
            for(const file of ch.files)console.log(`  ${file.file} — ${file.MiB} MiB`);
          }
          console.log('These files are NOT confirmed missing. Check Discord before manual upload.');
          console.log(`CSV report: ${paths.csv}`);
          console.log(`JSON report: ${paths.json}`);
          continue;
        }
        const repairPlan=mode==='5'?await previewRetry(cli,root):null;
        if(mode==='5'&&!repairPlan)continue;
        if(!context){
          const {chromium}=require('playwright-core');
          const profile=path.join(os.homedir(),'.discord-migration-download-browser');
          await fsp.mkdir(profile,{recursive:true,mode:0o700});
          console.log('\nLaunching Chrome with a dedicated DOWNLOAD profile:',profile);
          console.log('Sign in to the source server through Chrome. Never paste a user token.');
          try{context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,
            viewport:{width:1400,height:900},acceptDownloads:true});}
          catch(e){if(/existing browser session|profile is already in use/i.test(e.message))
            throw new Error('The download Chrome profile is already in use. Close the other downloader first.');throw e;}
          context.on('close',()=>{context=null;page=null;});
          page=context.pages()[0]||await context.newPage();
          page.setDefaultTimeout(20000);
          await page.goto('https://discord.com/app',{waitUntil:'domcontentloaded',timeout:60000});
          await cli.question('When signed in and source server is visible, press Enter... ');
        }
        if(interrupted)break;
        if(mode==='2')await runSingle(page,cli,root);
        else if(mode==='5')await runRetry(page,cli,root,repairPlan);
        else await runCategory(page,cli,root);
      }catch(error){
        if(interrupted||error.code==='ERR_USE_AFTER_CLOSE')break;
        console.error('\nERROR:',error.message);
      }
    }
  }finally{cli.close();if(context)await context.close().catch(()=>{});}
}
if(require.main===module){
  process.on('SIGINT',()=>{interrupted=true;console.log('\nStopping at the next checkpoint. Existing downloads are preserved.');});
  main().catch(error=>{console.error('\nERROR:',error.message);process.exitCode=1;});
}
module.exports={main,chooseArchive};
