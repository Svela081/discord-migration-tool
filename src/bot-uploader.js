'use strict';
// Official Discord BOT API uploader. No browser-based user-account posting.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {timelineFromFolder} = require('./timeline');
const {atomicJson} = require('./archive-index');
const {channelId,expandHome} = require('./utils');

const MAX_BOT_FILE_BYTES = 20 * 1024 * 1024; // Conservative: below 25 MiB Create Message total request cap.
const API = 'https://discord.com/api/v10';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function matchPlan(sources, targets) {
  const byName = new Map();
  for(const dest of targets){
    const key=String(dest.name||'').toLocaleLowerCase('en-US');
    byName.set(key,[...(byName.get(key)||[]),dest]);
  }
  return sources.map(source => {
    const matches=byName.get(String(source.sourceChannelName||'').toLocaleLowerCase('en-US'))||[];
    return {...source,target:matches.length===1?matches[0]:null,
      status:matches.length===1?'matched':matches.length>1?'ambiguous':'missing'};
  });
}
function archiveSubfolder(root, row) {
  const base=path.resolve(expandHome(root));
  const resolved=path.resolve(base,String(row.archiveFolder||''));
  if(!row.archiveFolder||!resolved.startsWith(base+path.sep))throw new Error('Indexed archive path escaped the archive root');
  return resolved;
}
async function discordRequest(token,method,resource,{json,form}={}){
  const headers={Authorization:`Bot ${token}`};
  let body;
  if(json!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(json);}
  if(form)body=form;
  for(let attempts=0;attempts<4;attempts++){
    let result;
    try{result=await fetch(API+resource,{method,headers,body,signal:AbortSignal.timeout(180_000)});}
    catch(err){
      const error=new Error(`Network outcome uncertain: ${err.message}`);error.uncertain=method==='POST';throw error;
    }
    if(result.status===429){
      const j=await result.json().catch(()=>({}));
      const delay=Number(j.retry_after||result.headers.get('retry-after')||1)*1000;
      if(attempts===3)throw new Error(`Rate limit persists after retries (${result.status})`);
      if(!Number.isFinite(delay)||delay>120_000)throw new Error('Unexpected API retry-after delay');
      await sleep(Math.max(1000,delay+250));
      continue;
    }
    if(!result.ok){
      const details=(await result.text().catch(()=>''));
      const e=new Error(`Discord API ${method} ${resource}: HTTP ${result.status} ${details.slice(0,500)}`);
      e.uncertain=method==='POST'&&result.status>=500;
      throw e;
    }
    return result.status===204?{}:result.json();
  }
  throw new Error('Unexpected retry exhaustion');
}
async function destinationCategory(token, anchorUrl){
  const parsed=channelId(anchorUrl);
  if(!parsed)throw new Error('Destination anchor URL must include server and channel IDs');
  const anchor=await discordRequest(token,'GET',`/channels/${parsed.channel}`);
  if(anchor.guild_id!==parsed.guild)throw new Error('Destination anchor belongs to another server');
  if(anchor.type!==0 && anchor.type!==4)throw new Error('Destination anchor must be a text channel or category');
  const cat=anchor.type===4?anchor.id:anchor.parent_id;
  if(!cat)throw new Error('Anchor is not inside a category');
  const all=await discordRequest(token,'GET',`/guilds/${parsed.guild}/channels`);
  if(!Array.isArray(all))throw new Error('Discord did not return a channel list');
  const cats=all.filter(c=>c.type===4 && c.id===cat);
  const channels=all.filter(c=>c.type===0&&c.parent_id===cat);
  return {guildId:parsed.guild,categoryId:cat,categoryName:cats[0]?.name||'(category)',channels};
}
// Idempotent destination structure planning. Only exact case-insensitive names
// within the chosen parent category can be reused; duplicates are ambiguous.
function sameName(a,b){return String(a||'').normalize('NFC').toLocaleLowerCase('en-US')===String(b||'').normalize('NFC').toLocaleLowerCase('en-US');}
function categoryStructurePlan(sourceChannels, allChannels, categoryName, {categoryId=null}={}){
  if(!Array.isArray(allChannels))throw new Error('Invalid guild channels response');
  const categories=allChannels.filter(c=>c.type===4);
  let category=null,categoryStatus;
  if(categoryId){
    const selected=categories.filter(c=>c.id===categoryId);
    if(selected.length!==1)throw new Error(`Destination category ID ${categoryId} not found or inaccessible`);
    category=selected[0];categoryStatus='reuse';
    if(!sameName(category.name,categoryName))throw new Error(`Category ID ${categoryId} is named "${category.name}", not "${categoryName}". Correct the target category name before proceeding.`);
  }else{
    const matched=categories.filter(c=>sameName(c.name,categoryName));
    if(matched.length>1)throw new Error(`Multiple destination categories named "${categoryName}". Supply the exact category ID to disambiguate.`);
    category=matched[0]||null;
    categoryStatus=category?'reuse':'create';
  }
  const children=category?allChannels.filter(c=>c.parent_id===category.id):[];
  const plans=sourceChannels.map(source=>{
    const matches=children.filter(c=>c.type===0&&sameName(c.name,source.sourceChannelName));
    if(matches.length>1)return {...source,status:'ambiguous',target:null};
    if(matches.length===1)return {...source,status:'reuse',target:matches[0]};
    // If the existing same-named channel is not a text channel, do not
    // attempt to create a conflicting second channel with that name.
    if(children.some(c=>sameName(c.name,source.sourceChannelName)))return {...source,status:'wrong-type',target:null};
    return {...source,status:'create',target:null};
  });
  const sourceDuplicates=new Map();
  for(const row of plans){
    const key=String(row.sourceChannelName||'').normalize('NFC').toLocaleLowerCase('en-US');
    sourceDuplicates.set(key,(sourceDuplicates.get(key)||0)+1);
  }
  for(const row of plans){
    if(sourceDuplicates.get(String(row.sourceChannelName||'').normalize('NFC').toLocaleLowerCase('en-US'))>1){row.status='duplicate-source';row.target=null;}
  }
  const existingChildCount=category?children.length:0;
  const needed=plans.filter(r=>r.status==='create').length;
  return {category,categoryStatus,categoryName,channels:plans,existingChildCount,
    capacityOk:existingChildCount+needed<=50,
    safe:plans.every(r=>r.status==='reuse'||r.status==='create')&&existingChildCount+needed<=50};
}
async function guildChannels(token,guildId){
  if(!/^\d{15,22}$/.test(guildId||''))throw new Error('Invalid destination server ID');
  const rows=await discordRequest(token,'GET',`/guilds/${guildId}/channels`);
  if(!Array.isArray(rows))throw new Error('Discord did not return a channel list');
  return rows;
}
function ensureValidStructure(plan){
  if(!plan.capacityOk)throw new Error('The destination category would exceed Discord’s 50-channel limit. Split the archive into another category before retrying.');
  if(!plan.safe)throw new Error('Ambiguous, duplicate or wrong-type channels found. No server changes made. Correct these names before continuing.');
}
async function applyStructurePlan(token,guildId,sourceChannels,categoryName,{categoryId=null,logger=console,stop=()=>false}={}){
  // Re-read before changes to avoid stale previews and duplicate creation.
  let fresh=await guildChannels(token,guildId);
  let plan=categoryStructurePlan(sourceChannels,fresh,categoryName,{categoryId});
  ensureValidStructure(plan);
  const created={categories:[],channels:[]};
  let destCategory=plan.category;
  if(!destCategory){
    if(stop())throw new Error('Interrupted before creating category');
    destCategory=await discordRequest(token,'POST',`/guilds/${guildId}/channels`,{json:{name:categoryName,type:4}});
    if(destCategory.type!==4||!destCategory.id)throw new Error('Category creation response not verified; inspect destination before retrying');
    created.categories.push({id:destCategory.id,name:destCategory.name});
    logger.log(`Created destination category "${destCategory.name}" (${destCategory.id})`);
  }
  const mapped=[];
  for(const source of sourceChannels){
    if(stop())throw new Error('Interrupted: completed channel creations remain in destination');
    // Every iteration refreshes actual server state. A second concurrent job
    // must not accidentally cause us to create a duplicate channel.
    fresh=await guildChannels(token,guildId);
    plan=categoryStructurePlan([source],fresh,categoryName,{categoryId:destCategory.id});
    ensureValidStructure(plan);
    const found=plan.channels[0];
    let target=found.target;
    let operation='reused';
    if(found.status==='create'){
      target=await discordRequest(token,'POST',`/guilds/${guildId}/channels`,
        {json:{name:source.sourceChannelName,type:0,parent_id:destCategory.id}});
      if(!target?.id||target?.parent_id!==destCategory.id||target.type!==0)
        throw new Error(`Channel creation response not verified for #${source.sourceChannelName}; inspect Discord before retrying`);
      operation='created';created.channels.push({id:target.id,name:target.name,categoryId:destCategory.id});
      logger.log(`  Created #${source.sourceChannelName} (${target.id})`);
    }else{logger.log(`  Reused #${source.sourceChannelName} (${target.id})`);}
    mapped.push({...source,target,status:operation});
  }
  return {category:destCategory,channels:mapped,created};
}
async function destinationHasMessages(token,channel){
  const rows=await discordRequest(token,'GET',`/channels/${channel.id}/messages?limit=1`);
  if(!Array.isArray(rows))throw new Error(`Unable to verify messages in #${channel.name}`);
  return rows.length>0;
}
function journalNames(root,source,target){
  const dir=path.join(expandHome(root),'.bot-migration-journals');
  const prefix=`${source.sourceChannelId}_to_${target.id}`;
  return {journal:path.join(dir,prefix+'.jsonl'),pending:path.join(dir,prefix+'.pending.json')};
}
async function readJournal(file){
  try{return (await fs.readFile(file,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
}
// Resume only when *every* current destination message is accounted for by
// this tool's successful-post journal. Older browser uploads have no such proof
// and remain excluded from automatic nonempty-channel imports.
async function verifyJournalOnlyHistory(token,root,source,target,{request=discordRequest,maxPages=100}={}){
  const paths=journalNames(root,source,target);
  const prior=await readJournal(paths.journal);
  if(!prior.length)return {ok:false,reason:'no bot upload journal'};
  try{
    await fs.access(paths.pending);
    return {ok:false,reason:'unresolved upload marker requires manual review'};
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const ids=new Set();
  for(const entry of prior){
    if(!/^\d{15,22}$/.test(String(entry.destinationMessageId||''))||entry.destinationChannelId!==target.id)
      return {ok:false,reason:'journal contains invalid or mismatched destination message IDs'};
    if(ids.has(entry.destinationMessageId))return {ok:false,reason:'duplicate destination message ID in journal'};
    ids.add(entry.destinationMessageId);
  }
  const seen=new Set();let before=null;let ended=false;
  for(let page=0;page<maxPages;page++){
    const qs=`?limit=100${before?'&before='+encodeURIComponent(before):''}`;
    const rows=await request(token,'GET',`/channels/${target.id}/messages${qs}`);
    if(!Array.isArray(rows))return {ok:false,reason:'Discord history is not a message array'};
    for(const msg of rows){
      if(!msg||!/^\d{15,22}$/.test(String(msg.id||'')))return {ok:false,reason:'unverifiable Discord message ID'};
      if(!ids.has(msg.id))return {ok:false,reason:'destination contains messages absent from bot journal'};
      if(seen.has(msg.id))return {ok:false,reason:'Discord history pagination repeated a message'};
      seen.add(msg.id);
    }
    if(rows.length<100){ended=true;break;}
    const next=rows.at(-1).id;
    if(next===before)return {ok:false,reason:'Discord history pagination did not advance'};
    before=next;
  }
  if(!ended)return {ok:false,reason:'destination history exceeds verification page limit'};
  if(seen.size!==ids.size)return {ok:false,reason:'journal records messages no longer present in destination'};
  return {ok:true,verifiedMessages:seen.size};
}
async function hasBotJournal(root,source,target){
  const {journal,pending}=journalNames(root,source,target);
  try{await fs.access(pending);return true;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  try{return (await readJournal(journal)).length>0;}
  catch(e){throw e;}
}
async function sendItem(token,channelId,item){
  const resource=`/channels/${channelId}/messages`;
  // Each archived item needs a distinct nonce, even if an original Discord
  // message contained both a file and a link. Discord limits it to 25 chars.
  const nonce=createHash('sha256').update(`${channelId}|${item.key}`).digest('hex').slice(0,24);
  if(item.type==='link')return discordRequest(token,'POST',resource,{json:{content:item.url,allowed_mentions:{parse:[]},nonce,enforce_nonce:!!nonce}});
  const contents=await fs.readFile(item.absolute);
  const form=new FormData();
  form.append('payload_json',JSON.stringify({allowed_mentions:{parse:[]},nonce,enforce_nonce:!!nonce,
    attachments:[{id:0,filename:path.basename(item.absolute)}]}));
  form.append('files[0]',new Blob([contents]),path.basename(item.absolute));
  return discordRequest(token,'POST',resource,{form});
}
async function migratePair(token,root,source,target,{logger=console,stop=()=>false,verifiedPresentKeys=new Set()}={}){
  const folder=archiveSubfolder(root,source);
  const paths=journalNames(root,source,target);
  const previous=await readJournal(paths.journal);
  const done=new Set(previous.map(r=>r.key));
  const reconciledPresent=new Set(verifiedPresentKeys);
  const {entries,unknownOrder}=await timelineFromFolder(folder);
  try{
    const pending=JSON.parse(await fs.readFile(paths.pending,'utf8'));
    if(pending && done.has(pending.key))await fs.rm(paths.pending,{force:true});
    else if(pending){
      const entry=entries.find(e=>e.key===pending.key&&e.type==='media');
      if(pending.sourceChannelId&&pending.sourceChannelId!==source.sourceChannelId ||
         pending.destinationChannelId&&pending.destinationChannelId!==target.id)
        throw new Error(`Pending upload belongs to a different source/destination: ${paths.pending}`);
      const size=entry?(await fs.stat(entry.absolute)).size:0;
      if(size<=MAX_BOT_FILE_BYTES)
        throw new Error(`Unverified prior upload for ${source.sourceChannelName}: ${pending.file||'link'}. Review destination and ${paths.pending} before resuming.`);
      // Preserve the original pending marker in a separate manual-review file.
      // Do not delete it: the old API request MAY have succeeded. This permits
      // later small items to get their own pending markers without overwriting it.
      const suffix=createHash('sha256').update(pending.key).digest('hex').slice(0,12);
      const manual=paths.pending.replace(/\.pending\.json$/,`.oversized-pending-${suffix}-${Date.now()}.json`);
      await fs.rename(paths.pending,manual);
      logger.warn(`Oversized pending upload moved to manual-review marker: ${manual}`);
    }
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const stats={source:source.sourceChannelName,sourceChannelId:source.sourceChannelId,
    destinationChannelId:target.id,posted:0,alreadyPosted:0,alreadyPresent:0,oversized:[],unknownOrder};
  if(unknownOrder)logger.warn(`WARNING: ${unknownOrder} items have no chronological source message ID.`);
  for(const item of entries){
    if(stop())throw new Error('Interrupted: prior successful posts are journaled.');
    if(done.has(item.key)){stats.alreadyPosted++;continue;}
    if(reconciledPresent.has(item.key)){stats.alreadyPresent++;continue;}
    if(item.type==='media'){
      const stat=await fs.stat(item.absolute);
      if(stat.size>MAX_BOT_FILE_BYTES){
        stats.oversized.push({file:item.file,bytes:stat.size,reason:'above bot upload cap; not uploaded'});
        continue;
      }
    }
    await atomicJson(paths.pending,{key:item.key,sourceChannelId:source.sourceChannelId,destinationChannelId:target.id,
      file:item.type==='media'?item.file:null,at:new Date().toISOString()});
    try{
      const posted=await sendItem(token,target.id,item);
      if(!posted.id||posted.channel_id!==target.id)throw Object.assign(new Error('Uncertain upload response'),{uncertain:true});
      await fs.mkdir(path.dirname(paths.journal),{recursive:true});
      await fs.appendFile(paths.journal,JSON.stringify({key:item.key,destinationChannelId:target.id,destinationMessageId:posted.id,
        postedAt:new Date().toISOString()})+'\n');
      await fs.rm(paths.pending,{force:true});
      done.add(item.key);stats.posted++;
      logger.log(`  ✓ ${item.type==='media'?item.file:'external link'} -> message ${posted.id}`);
    }catch(e){
      if(!e.uncertain) await fs.rm(paths.pending,{force:true}).catch(()=>{});
      else logger.error(`Submission may have succeeded. Pending marker retained: ${paths.pending}`);
      throw e;
    }
  }
  return stats;
}
module.exports={matchPlan,archiveSubfolder,destinationCategory,discordRequest,migratePair,MAX_BOT_FILE_BYTES,journalNames,sameName,
  categoryStructurePlan,guildChannels,applyStructurePlan,destinationHasMessages,verifyJournalOnlyHistory,hasBotJournal};
