'use strict';

// Discord's introductory message is a stronger signal than a stationary
// scrollbar. Keep these expressions specific to the channel welcome block:
// user-authored messages that mention 'welcome' are not sufficient.
const WELCOME_HEADING_PATTERN = String.raw`^welcome\s+to(?:\s|$)`;
const CHANNEL_START_PATTERN = String.raw`\bthis\s+is\s+the\s+(?:start|beginning)\s+of\b`;

function isChannelWelcomeText(heading, description) {
  return new RegExp(WELCOME_HEADING_PATTERN, 'i').test(String(heading || '').trim()) &&
    new RegExp(CHANNEL_START_PATTERN, 'i').test(String(description || ''));
}

module.exports = {WELCOME_HEADING_PATTERN, CHANNEL_START_PATTERN, isChannelWelcomeText};
