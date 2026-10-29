'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {cleanName, channelId, validMediaUrl, mediaKind, mediaKey, looksExternalLink, outputFolder} = require('../src/utils');

test('accepts official Discord channel links only', () => {
  assert.deepEqual(channelId('https://discord.com/channels/123/456'), {guild:'123',channel:'456'});
  assert.equal(channelId('https://example.com/channels/123/456'), null);
});
test('sanitizes unsafe folder names', () => {
  assert.equal(cleanName('../AAA: photos'), '_AAA_ photos');
  assert.equal(cleanName(''), 'unnamed');
});
test('accepts signed attachment URLs, rejects nonattachment URLs', () => {
  assert.equal(validMediaUrl('https://cdn.discordapp.com/attachments/1/2/photo.jpg?ex=123&hm=secret'), true);
  assert.equal(validMediaUrl('https://evil.example/attachments/1/2/photo.jpg'), false);
  assert.equal(validMediaUrl('https://cdn.discordapp.com/avatars/1/pic.png'), false);
});
test('classifies image and video file types', () => {
  assert.equal(mediaKind('https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=2'), 'Videos');
  assert.equal(mediaKind('https://cdn.discordapp.com/attachments/1/2/image.webp'), 'Images');
});
test('source key never saves expiring signed query string', () => {
  assert.equal(mediaKey('https://cdn.discordapp.com/attachments/1/2/p.png?ex=secret'), '/attachments/1/2/p.png');
});
test('records non-Discord embed links', () => {
  assert.equal(looksExternalLink('https://youtube.com/watch?v=1'), true);
  assert.equal(looksExternalLink('https://discord.com/channels/1/2'), false);
});
test('uses the configured category and channel folder', () => {
  assert.match(outputFolder('~/Documents/Discord Migration Tool', {url:'https://discord.com/channels/123/456',category:'Photos',folder:'AAA'}), /Discord Migration Tool\/Photos\/AAA$/);
});
