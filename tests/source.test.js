'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {resolveChannelInput, makeSingleChannelConfig} = require('../src/source');
const OLD = 'https://discord.com/channels/1111111111111111111/444444444444444444';
const NEXT = 'https://discord.com/channels/1111111111111111111/555555555555555555';

test('accepts full URLs for a new channel on any server', () => {
  assert.equal(resolveChannelInput(NEXT, OLD), NEXT);
  assert.equal(resolveChannelInput('https://discord.com/channels/222222222222222222/333333333333333333?foo=bar'),
    'https://discord.com/channels/222222222222222222/333333333333333333');
});
test('accepts a channel ID only with saved server URL', () => {
  assert.equal(resolveChannelInput('555555555555555555', OLD), NEXT);
  assert.throws(() => resolveChannelInput('555555555555555555'), /full URL/);
});
test('Enter reruns the last selected channel if present', () => {
  assert.equal(resolveChannelInput('', OLD), OLD);
  assert.throws(() => resolveChannelInput(''), /full Discord/);
});
test('rejects malformed input and non-Discord URLs', () => {
  assert.throws(() => resolveChannelInput('https://example.org/channels/123/456'), /Expected/);
  assert.throws(() => resolveChannelInput('bad input'), /Expected/);
});
test('switches channels without losing archive root or old channel references', () => {
  const prior = {outputRoot:'~/Documents/Discord Migration Tool', channels:[{url:OLD, folder:'sample-channel',category:''}], maxScrolls:123};
  const cfg = makeSingleChannelConfig(prior, NEXT, prior.outputRoot);
  assert.equal(cfg.channels.length,1);
  assert.equal(cfg.channels[0].url, NEXT);
  assert.equal(cfg.channels[0].folder, '');
  assert.equal(cfg.outputRoot,prior.outputRoot);
  assert.equal(cfg.channelHistory[0].folder,'sample-channel');
  assert.equal(cfg.maxScrolls,123);
  assert.deepEqual(cfg.categories,[]);
});
test('preserves an old channel custom name if reprocessing it', () => {
  const prior = {channels:[{url:OLD, folder:'sample-channel', category:'Photos'}]};
  const cfg = makeSingleChannelConfig(prior, OLD, '~/Documents/Discord Migration Tool');
  assert.equal(cfg.channels[0].folder,'sample-channel');
  assert.equal(cfg.channels[0].category,'Photos');
});
const {nextChannelInput} = require('../src/source');

test('next-channel prompt closes the session on empty input', () => {
  assert.equal(nextChannelInput('', OLD), null);
  assert.equal(nextChannelInput('   ', OLD), null);
});
test('next-channel prompt takes full URL or an ID on the same server', () => {
  assert.equal(nextChannelInput(NEXT, OLD), NEXT);
  assert.equal(nextChannelInput('555555555555555555', OLD), NEXT);
  assert.throws(() => nextChannelInput('not a URL', OLD), /Expected/);
});
