'use strict';

// Traverse toward older messages until the scroll container is demonstrably
// at its top after rendering. Counts are diagnostics, not completion criteria.
// A stationary scroller away from the top is an incomplete scan, not success.
class ScanProgress {
  constructor({topLimit = 3, stationaryLimit = 4} = {}) {
    this.topLimit = topLimit;
    this.stationaryLimit = stationaryLimit;
    this.topChecks = 0;
    this.stationaryChecks = 0;
  }

  observe(newIds, movement, settled) {
    if (settled?.welcomeVisible) return 'channel-welcome-banner';
    if (!movement?.found || !settled?.found) return 'message-scroller-not-found';
    // Verify the position *after* allowing older messages to render: if Discord
    // loaded earlier history it can push the scroll position down again.
    if (settled.top && newIds === 0) this.topChecks++;
    else this.topChecks = 0;

    const moved = Math.abs(movement.after - movement.before) >= 2;
    if (!moved && !settled.top && newIds === 0) this.stationaryChecks++;
    else this.stationaryChecks = 0;

    if (this.topChecks >= this.topLimit) return 'stable-oldest-message-boundary';
    if (this.stationaryChecks >= this.stationaryLimit) return 'scroll-stalled-before-oldest';
    return null;
  }
}
module.exports = {ScanProgress};
