'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isChannelWelcomeText} = require('../src/history-end');

test('detects the channel-start banner seen in Discord', () => {
  assert.equal(isChannelWelcomeText('Welcome to #photos!', 'This is the start of the #photos channel.'), true);
  assert.equal(isChannelWelcomeText('Welcome to #general', 'This is the beginning of the #general channel.'), true);
});
test('requires BOTH an introductory heading and a description', () => {
  assert.equal(isChannelWelcomeText('Welcome to #photos', 'Recent photos are posted here.'), false);
  assert.equal(isChannelWelcomeText('Photos', 'This is the start of the channel.'), false);
  assert.equal(isChannelWelcomeText('Welcome to', 'This is some other text.'), false);
});
test('ignores incidental words such as welcome from unrelated content', () => {
  assert.equal(isChannelWelcomeText('I welcome you to the chat', 'This is the start of the stream.'), false);
  assert.equal(isChannelWelcomeText('Welcome to', 'This is the end of the channel.'), false);
});
