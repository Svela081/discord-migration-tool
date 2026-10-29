'use strict';
// Manual, inclusive source-category boundary. Discord's sidebar may include
// neighboring categories; never guess where one category ends.
function selectThroughChannel(channels,seedId,lastId){
  if(!Array.isArray(channels)||!channels.length)throw new Error('No channels available to select.');
  const begin=channels.findIndex(ch=>ch.id===seedId);
  const end=channels.findIndex(ch=>ch.id===lastId);
  if(begin<0)throw new Error('The source seed channel is missing from discovery.');
  if(end<begin)throw new Error('The last source channel must follow the seed channel in the sidebar list.');
  return channels.slice(begin,end+1);
}
module.exports={selectThroughChannel};
