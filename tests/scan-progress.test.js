'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ScanProgress} = require('../src/scan-progress');
const moving = {found:true, top:false, before:600, after:300};
const notTop = {found:true, top:false};
const top = {found:true, top:true};

test('does not stop while scrolling even if the same messages remain visible', () => {
  const scan = new ScanProgress();
  for (let n=0; n<25; n++) assert.equal(scan.observe(0, moving, notTop), null);
});
test('stops only after three confirmed checks at settled top without older IDs', () => {
  const scan = new ScanProgress();
  const reached = {found:true, top:true, before:100, after:0};
  assert.equal(scan.observe(3, reached, top), null);
  assert.equal(scan.observe(0, reached, top), null);
  assert.equal(scan.observe(0, reached, top), null);
  assert.equal(scan.observe(0, reached, top), 'stable-oldest-message-boundary');
});
test('resets top checks if Discord loads more history and moves off top', () => {
  const scan = new ScanProgress();
  const reached = {found:true, top:true, before:100, after:0};
  scan.observe(0, reached, top);
  scan.observe(0, reached, notTop);
  for (let n=0; n<2; n++) assert.equal(scan.observe(0, reached, top), null);
  assert.equal(scan.observe(0, reached, top), 'stable-oldest-message-boundary');
});
test('stationary before top is incomplete, not completed', () => {
  const scan = new ScanProgress();
  const stuck = {found:true, top:false, before:200, after:200};
  for (let n=0; n<3; n++) assert.equal(scan.observe(0, stuck, notTop), null);
  assert.equal(scan.observe(0, stuck, notTop), 'scroll-stalled-before-oldest');
});
test('new message IDs reset stationary detection', () => {
  const scan = new ScanProgress();
  const stuck = {found:true, top:false, before:200, after:200};
  for (let n=0; n<3; n++) scan.observe(0, stuck, notTop);
  assert.equal(scan.observe(2, stuck, notTop), null);
  assert.equal(scan.observe(0, stuck, notTop), null);
});
test('missing scroller is diagnosed', () => {
  const scan = new ScanProgress();
  assert.equal(scan.observe(0, {found:false}, notTop), 'message-scroller-not-found');
  assert.equal(scan.observe(0, moving, {found:false}), 'message-scroller-not-found');
});

test('visible channel welcome banner ends scan without repeated scrolls', () => {
  const scan = new ScanProgress();
  assert.equal(scan.observe(4, moving, {found:true, top:false, welcomeVisible:true}), 'channel-welcome-banner');
});

test('absence of channel welcome banner retains existing fallback', () => {
  const scan = new ScanProgress();
  const reached = {found:true, top:true, before:25, after:0};
  for (let n=0; n<2; n++) assert.equal(scan.observe(0, reached, {found:true, top:true, welcomeVisible:false}), null);
  assert.equal(scan.observe(0, reached, {found:true, top:true, welcomeVisible:false}), 'stable-oldest-message-boundary');
});
