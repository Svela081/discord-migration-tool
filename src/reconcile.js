'use strict';
// Read-only destination reconciliation. Only proven missing items may be uploaded.
// Matching attachments require same filename, byte count AND SHA-256 digest.
const fs = require('node:fs/promises');
const fsc = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {timelineFromFolder} = require('./timeline');
const {loadJsonl} = require('./archive');
const {archiveSubfolder, discordRequest, journalNames, MAX_BOT_FILE_BYTES} = require('./bot-uploader');

const MAX_HISTORY_PAGES = 100; // Refuse automatic uploads when the whole history cannot be inspected.
const MAX_REMOTE_VERIFY_BYTES = 512 * 1024 * 1024; // Never guess on huge files.
const isSnowflake = v => /^\d{15,22}$/.test(String(v||''));
const canonName = s => String(s||'').normalize('NFC');
const keyFor = (name,size) => `${canonName(name)}\u0000${size}`;
const sha = () => createHash('sha256');

async function fileDigest(file) {
  const hash = sha();
  for await(const chunk of fsc.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function attachmentDigest(attachment) {
  const u = new URL(attachment.url);
  if(u.protocol!=='https:' || !['cdn.discordapp.com','media.discordapp.net','attachments.discordapp.net'].includes(u.hostname))
    throw new Error('Attachment URL is not an approved Discord CDN address');
  if(!Number.isSafeInteger(attachment.size)||attachment.size<0||attachment.size>MAX_REMOTE_VERIFY_BYTES)
    throw new Error('Attachment too large to hash-verify automatically');
  const response = await fetch(u.href,{redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!response.ok||!response.body)throw new Error(`Discord attachment unavailable (HTTP ${response.status})`);
  const hash=sha();let total=0;
  for await(const chunk of response.body){
    total+=chunk.length;
    if(total>MAX_REMOTE_VERIFY_BYTES)throw new Error('Remote verification byte limit exceeded');
    hash.update(chunk);
  }
  if(total!==attachment.size)throw new Error('Downloaded verification bytes differ from Discord attachment metadata');
  return hash.digest('hex');
}
async function fetchCompleteHistory(token,targetId,{request=discordRequest,maxPages=MAX_HISTORY_PAGES}={}) {
  const result=[];let before=null;const seen=new Set();let complete=false;
  for(let page=0;page<maxPages;page++){
    const resource=`/channels/${targetId}/messages?limit=100${before?'&before='+encodeURIComponent(before):''}`;
    const rows=await request(token,'GET',resource);
    if(!Array.isArray(rows))throw new Error('Discord history was not an array');
    for(const msg of rows){
      if(!isSnowflake(msg?.id)||seen.has(msg.id))throw new Error('Invalid or repeated message ID in destination history');
      seen.add(msg.id);result.push(msg);
    }
    if(rows.length<100){complete=true;break;}
    const next=rows.at(-1)?.id;
    if(!next||next===before)throw new Error('Discord history pagination stalled');
    before=next;
  }
  if(!complete)throw new Error(`More than ${maxPages*100} messages; cannot verify full history`);
  return result;
}
function historyFingerprint(messages){
  const h=sha();
  for(const msg of messages){
    h.update(JSON.stringify({id:msg.id,content:msg.content||'',attachments:(msg.attachments||[]).map(a=>
      [a.id,a.filename,a.size])}));h.update('\n');
  }
  return h.digest('hex');
}
function mediaInventory(messages) {
  const attachments=[];
  for(const msg of messages){
    if(!Array.isArray(msg.attachments))throw new Error('Destination message lacks attachment inventory');
    for(const a of msg.attachments){
      if(typeof a.filename!=='string'||!Number.isSafeInteger(a.size)||!isSnowflake(msg.id)||!a.url)
        throw new Error('Destination attachment metadata is incomplete');
      attachments.push({...a,messageId:msg.id});
    }
  }
  return attachments;
}
function exactLink(url,text){
  const t=String(text||'').trim();
  return t===url || t===`<${url}>`;
}
async function countArchiveFailures(folder){
  const errors=await loadJsonl(path.join(folder,'errors.jsonl'));
  if(!errors.length)return 0;
  const manifests=await loadJsonl(path.join(folder,'download_manifest.jsonl'));
  const resolved=new Set(manifests.map(m=>m.sourcePath));
  return new Set(errors.filter(e=>e.sourcePath&&!resolved.has(e.sourcePath)).map(e=>e.sourcePath)).size;
}
async function countMissingLocalManifestFiles(folder){
  const manifest=await loadJsonl(path.join(folder,'download_manifest.jsonl'));
  const missing=new Set();
  for(const m of manifest){
    if(!m.file)continue;
    const resolved=path.resolve(folder,m.file);
    if(!resolved.startsWith(path.resolve(folder)+path.sep)){
      missing.add(m.file);continue;
    }
    try{if(!(await fs.stat(resolved)).isFile())missing.add(m.file);}
    catch(e){if(e.code==='ENOENT')missing.add(m.file);else throw e;}
  }
  return missing.size;
}
async function reconcileInventory(entries,messages,{getLocalHash=fileDigest,getRemoteHash=attachmentDigest}={}){
  const remote=mediaInventory(messages);
  const attachedByKey=new Map(),attachmentsByName=new Map();
  for(const attachment of remote){
    const key=keyFor(attachment.filename,attachment.size);
    if(!attachedByKey.has(key))attachedByKey.set(key,[]);
    attachedByKey.get(key).push(attachment);
    const n=canonName(attachment.filename);
    attachmentsByName.set(n,(attachmentsByName.get(n)||0)+1);
  }
  const localsByKey=new Map();const outcomes=new Map();
  const remoteHashCache=new Map();
  async function remoteHash(a) {
    const id=String(a.id||'')+'@'+a.messageId;
    if(!remoteHashCache.has(id))remoteHashCache.set(id,Promise.resolve().then(()=>getRemoteHash(a)));
    return remoteHashCache.get(id);
  }
  for(const item of entries){
    if(item.type==='link'){
      const occurrences=messages.filter(m=>exactLink(item.url,m.content)).length;
      if(occurrences)outcomes.set(item.key,{state:'present',reason:'exact URL found'});
      else if(messages.some(m=>String(m.content||'').includes(item.url)))
        outcomes.set(item.key,{state:'uncertain',reason:'URL embedded in a non-identical message'});
      else outcomes.set(item.key,{state:'missing',reason:'URL absent'});
      continue;
    }
    const stat=await fs.stat(item.absolute);
    if(!stat.isFile())throw new Error(`Local item is not a file: ${item.file}`);
    const name=path.basename(item.absolute);
    const key=keyFor(name,stat.size);
    if(!localsByKey.has(key))localsByKey.set(key,[]);
    localsByKey.get(key).push(item);
  }
  for(const [key,localItems] of localsByKey){
    const remoteCandidates=attachedByKey.get(key)||[];
    const name=key.split('\u0000')[0];
    if(!remoteCandidates.length){
      // Some earlier migrations renamed attachments. Same bytes with a different
      // filename can still prove identity; an unreadable same-size candidate
      // must never silently count as missing.
      const size=Number(key.slice(key.lastIndexOf('\u0000')+1));
      const renamedCandidates=remote.filter(a=>a.size===size);
      const localDigests=await Promise.all(localItems.map(item=>getLocalHash(item.absolute)));
      const otherHashes=[];let inaccessible=null;
      for(const a of renamedCandidates){
        try{otherHashes.push(await remoteHash(a));}
        catch(e){inaccessible=e.message;break;}
      }
      for(let i=0;i<localItems.length;i++){
        const item=localItems[i],digest=localDigests[i];
        const exact=otherHashes.filter(h=>h===digest).length;
        const copies=localDigests.filter(h=>h===digest).length;
        if(inaccessible)outcomes.set(item.key,{state:'uncertain',reason:`Could not hash-check renamed attachment: ${inaccessible}`});
        else if(exact>=copies)outcomes.set(item.key,{state:'present',reason:'Identical SHA-256 and size; destination filename differs'});
        else if(exact && exact!==copies)outcomes.set(item.key,{state:'uncertain',reason:'Renamed identical-file occurrence counts differ'});
        else if(attachmentsByName.has(name))outcomes.set(item.key,{state:'uncertain',reason:'Same filename exists with different file size'});
        else outcomes.set(item.key,{state:'missing',reason:'No matching attachment by filename or content hash'});
      }
      continue;
    }
    const candidateHashes=[];let unreadable=null;
    for(const attachment of remoteCandidates){
      try{candidateHashes.push(await remoteHash(attachment));}
      catch(e){unreadable=e.message;break;}
    }
    if(unreadable){
      for(const item of localItems)outcomes.set(item.key,{state:'uncertain',reason:`Could not hash-verify matching attachment: ${unreadable}`});
      continue;
    }
    const localHashes=[];
    for(const item of localItems)localHashes.push(await getLocalHash(item.absolute));
    const available=new Map(),required=new Map();
    for(const digest of candidateHashes)available.set(digest,(available.get(digest)||0)+1);
    for(const digest of localHashes)required.set(digest,(required.get(digest)||0)+1);
    for(let i=0;i<localItems.length;i++){
      const item=localItems[i],digest=localHashes[i];
      const sameLocal=required.get(digest)||0,sameRemote=available.get(digest)||0;
      if(sameLocal>1 && sameRemote!==sameLocal){
        outcomes.set(item.key,{state:'uncertain',reason:'Indistinguishable repeated attachments have different occurrence counts'});
      }else if(sameRemote>=sameLocal){
        outcomes.set(item.key,{state:'present',reason:'Filename + byte size + SHA-256 match'});
      }else if(remoteCandidates.length){
        // Filename/size match but bytes differ: may have been processed or altered.
        outcomes.set(item.key,{state:'uncertain',reason:'Matching filename/size but different SHA-256 content'});
      }
    }
  }
  return outcomes;
}
async function reconcilePair(token,root,source,target,options={}) {
  const folder=archiveSubfolder(root,source);
  const {entries,unknownOrder}=await timelineFromFolder(folder);
  const messages=await fetchCompleteHistory(token,target.id,{request:options.request,maxPages:options.maxPages});
  const paths=journalNames(root,source,target);
  const journal=await loadJsonl(paths.journal);
  const messageById=new Map(messages.map(m=>[m.id,m]));
  const journalKeys=new Set(),journalIds=new Set();
  let hardStop=null;
  for(const r of journal){
    if(!r.key||r.destinationChannelId!==target.id||!isSnowflake(r.destinationMessageId)||
       journalKeys.has(r.key)||journalIds.has(r.destinationMessageId)||!messageById.has(r.destinationMessageId)){
      hardStop='Bot upload journal does not match current destination history; manual review required';break;
    }
    journalKeys.add(r.key);journalIds.add(r.destinationMessageId);
  }
  // Pre-classify oversized files as MANUAL rather than "missing". The bot
  // cannot safely replay them. This also lets a pending marker referencing an
  // oversized local file remain preserved without blocking smaller missing items.
  const oversizedInfo=new Map();
  for(const item of entries){
    if(item.type!=='media')continue;
    const {size}=await fs.stat(item.absolute);
    if(size>MAX_BOT_FILE_BYTES)oversizedInfo.set(item.key,{bytes:size,file:item.file});
  }
  const oversizedPendingKeys=new Set();
  try{
    const pending=JSON.parse(await fs.readFile(paths.pending,'utf8'));
    if(pending && !journalKeys.has(pending.key)){
      if(oversizedInfo.has(pending.key) &&
         (!pending.sourceChannelId||pending.sourceChannelId===source.sourceChannelId) &&
         (!pending.destinationChannelId||pending.destinationChannelId===target.id)){
        oversizedPendingKeys.add(pending.key);
      }else hardStop='Unresolved pending upload marker; manual review required';
    }
  }catch(e){if(e.code!=='ENOENT')hardStop='Unreadable pending upload marker; manual review required';}
  const normalEntries=entries.filter(item=>!oversizedInfo.has(item.key));
  const outcomes=await reconcileInventory(normalEntries,messages,options);
  for(const item of entries){
    const extra=oversizedInfo.get(item.key);
    if(!extra)continue;
    // No automatic hash download required for files the bot cannot upload.
    // A validated journal + matching attachment metadata can establish that
    // the bot already uploaded it; otherwise its presence is unconfirmed.
    const record=journal.find(r=>r.key===item.key);
    const documented=record&&messages.some(m=>m.id===record.destinationMessageId &&
      (m.attachments||[]).some(a=>a.filename===path.basename(item.file)&&a.size===extra.bytes));
    if(documented)outcomes.set(item.key,{state:'present',reason:'Existing bot journal and Discord attachment metadata match; oversized file not hash-verified'});
    else {
      const possiblyPresent=messages.some(m=>(m.attachments||[]).some(a=>a.filename===path.basename(item.file)&&a.size===extra.bytes));
      outcomes.set(item.key,{state:'manual',reason:possiblyPresent?
        'Matching attachment filename and size exists; manually verify identity before upload':
        'Not found by filename and size; check destination before manual upload'});
    }
  }
  for(const item of entries){
    const o=outcomes.get(item.key);
    if(!o)throw new Error('Reconciliation did not classify every local item');
    if(journalKeys.has(item.key) && o.state!=='present') {
      hardStop='An item in the bot journal does not match its destination attachment/link; manual review required';
      outcomes.set(item.key,{state:'uncertain',reason:hardStop});
    }
  }
  const present=[],missing=[],uncertain=[],oversized=[];
  for(const item of entries){
    const row={key:item.key,type:item.type,file:item.file||null,url:item.url||null,...outcomes.get(item.key)};
    if(row.state==='present')present.push(row);
    else if(row.state==='missing')missing.push(row);
    else if(row.state==='manual')oversized.push({...row,bytes:oversizedInfo.get(item.key).bytes,pendingMarker:oversizedPendingKeys.has(item.key)});
    else uncertain.push(row);
  }
  const unresolvedArchiveFailures=await countArchiveFailures(folder);
  const missingLocalManifestFiles=await countMissingLocalManifestFiles(folder);
  const fingerprint=historyFingerprint(messages);
  const safeToUpload=!hardStop && !uncertain.length;
  return {source:source.sourceChannelName,sourceChannelId:source.sourceChannelId,destinationChannelId:target.id,
    localCount:entries.length,destinationMessageCount:messages.length,unknownOrder,unresolvedArchiveFailures,missingLocalManifestFiles,
    present,missing,uncertain,oversized,hardStop,safeToUpload,
    // Fingerprint tracks all destination message IDs, text and attachment metadata.
    fingerprint};
}
module.exports={fileDigest,attachmentDigest,fetchCompleteHistory,historyFingerprint,reconcileInventory,reconcilePair,countArchiveFailures,countMissingLocalManifestFiles};
