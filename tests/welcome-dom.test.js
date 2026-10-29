'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readScrollState} = require('../src/capture');

function buildFakePage({description='This is the start of the #photos channel.', headingText='Welcome to #photos!', inMessage=false, visible=true}={}) {
  const body = {};
  const introBlock = {innerText:`${headingText}\n${description}`, parentElement:null};
  const heading = {
    textContent:headingText,
    parentElement:introBlock,
    getBoundingClientRect() {return {top:visible ? 80 : -300, bottom:visible ? 150 : -240, width:300,height:70};},
    closest() {return inMessage ? {} : null;},
  };
  const scroller = {
    clientHeight:900, scrollHeight:2600, scrollTop:0, parentElement:body,
    querySelectorAll() {return [heading];},
    querySelector() {return null;},
    getBoundingClientRect() {return {top:0,bottom:900};},
  };
  introBlock.parentElement = scroller;
  const messages = {parentElement:scroller};
  const fakeDocument = {body, querySelector(selector) {return selector === '[data-list-id="chat-messages"]' ? messages : null;}, querySelectorAll(){return []}};
  return {evaluate: async (cb,arg) => {
    const oldDocument=global.document, oldStyle=global.getComputedStyle;
    global.document=fakeDocument;
    global.getComputedStyle=element=>({overflowY: element===scroller ? 'auto' : 'visible'});
    try {return cb(arg);} finally {global.document=oldDocument;global.getComputedStyle=oldStyle;}
  }};
}

test('detects the rendered, visible channel-start banner within message scroller', async () => {
  const state = await readScrollState(buildFakePage());
  assert.equal(state.found,true);
  assert.equal(state.welcomeVisible,true);
  assert.equal(state.top,true);
});

test('ignores a user-authored message mimicking the banner', async () => {
  const state = await readScrollState(buildFakePage({inMessage:true}));
  assert.equal(state.welcomeVisible,false);
});

test('ignores an offscreen welcome banner and missing channel-start description', async () => {
  assert.equal((await readScrollState(buildFakePage({visible:false}))).welcomeVisible,false);
  assert.equal((await readScrollState(buildFakePage({description:'Hello friends!'}))).welcomeVisible,false);
});
