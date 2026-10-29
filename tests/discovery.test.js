'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isSnowflake, normalizeCandidates, parseChannelReferences} = require('../src/discovery');

test('category IDs are plain Discord snowflakes', () => {
  assert.ok(isSnowflake('666666666666666666'));
  assert.equal(isSnowflake('not_an_id'), false);
  assert.equal(isSnowflake('123'), false);
});

test('only channels within the selected server are retained', () => {
  const rows = [
    {url:'https://discord.com/channels/123456789012345678/777777777777777777',name:'pictures'},
    {url:'https://discord.com/channels/123456789012345678/777777777777777777',name:'duplicate'},
    {url:'https://discord.com/channels/123456789012345679/888888888888888888',name:'other server'},
    {url:'https://discord.com/channels/123456789012345678/666666666666666666',name:'category itself'},
  ];
  assert.deepEqual(normalizeCandidates(rows,'123456789012345678','666666666666666666'), [{
    id:'777777777777777777',
    url:'https://discord.com/channels/123456789012345678/777777777777777777',
    folder:'pictures'
  }]);
});

test('channel names are sanitized before being used as local paths', () => {
  const rows = [{url:'https://discord.com/channels/123456789012345678/777777777777777777',name:'../photos:videos'}];
  assert.equal(normalizeCandidates(rows,'123456789012345678','666666666666666666')[0].folder, '_photos_videos');
});


test('manual category fallback accepts channel IDs and complete links, without duplicates', () => {
  const guild = '123456789012345678';
  const result = parseChannelReferences(`777777777777777777, 888888888888888888
https://discord.com/channels/${guild}/777777777777777777`, guild);
  assert.deepEqual(result, ['777777777777777777','888888888888888888']);
});

test('manual category fallback rejects other-server URLs', () => {
  assert.throws(() => parseChannelReferences('https://discord.com/channels/123456789012345679/777777777777777777', '123456789012345678'), /different-server/);
  assert.throws(() => parseChannelReferences('garbage', '123456789012345678'), /Invalid/);
});
