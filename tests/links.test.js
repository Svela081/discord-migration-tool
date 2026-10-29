'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeExternalLink, cleanedRecords} = require('../src/links');

test('Mega folder URLs MUST have the decryption key (# fragment)', () => {
  assert.equal(normalizeExternalLink('https://mega.nz/folder/TEST_FOLDER'), null);
  assert.equal(normalizeExternalLink('https://mega.nz/folder/TEST_FOLDER#EXAMPLE_KEY'),
    'https://mega.nz/folder/TEST_FOLDER#EXAMPLE_KEY');
});
test('extracts full Mega URL from visible link text when preview href loses fragment', () => {
  assert.equal(normalizeExternalLink('https://mega.nz/folder/TEST_FOLDER',
    'https://mega.nz/folder/TEST_FOLDER#KEY'), 'https://mega.nz/folder/TEST_FOLDER#KEY');
});
test('removes Mega preview assets and filters invalid old links', () => {
  const fixed = cleanedRecords([
    'https://mega.nz/rich-folder.png',
    'https://mega.nz/folder/TEST_FOLDER',
    {url:'https://mega.nz/folder/TEST_FOLDER#KEY', messageId:'42'},
    {url:'https://mega.nz/folder/TEST_FOLDER#KEY', messageId:'42'},
    'https://example.org/other',
  ]);
  assert.deepEqual(fixed.map(x=>x.url), ['https://example.org/other', 'https://mega.nz/folder/TEST_FOLDER#KEY']);
});
test('keeps full non-Mega links, including fragments and parameters', () => {
  assert.equal(normalizeExternalLink('https://example.org/video?id=123#start'), 'https://example.org/video?id=123#start');
});
