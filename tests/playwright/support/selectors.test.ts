import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chord, tid } from './selectors';

describe('selectors: tid', () => {
  it('accepts filters written in the id and attributes (same rules as tests/support/ui.ts)', () => {
    assert.equal(tid('graph-canvas'), '[data-testid="graph-canvas"]');
    assert.equal(tid('toast[data-kind=error]'), '[data-testid="toast"][data-kind=error]');
    assert.equal(
      tid('sidebar-branch-item[data-ref="refs/heads/topic"][data-current=true]'),
      '[data-testid="sidebar-branch-item"][data-ref="refs/heads/topic"][data-current=true]',
    );
    assert.equal(tid('sidebar-branch-item', { ref: 'refs/heads/topic', current: true }), '[data-testid="sidebar-branch-item"][data-ref="refs/heads/topic"][data-current="true"]');
    assert.equal(tid('op-banner', { stopReason: 'empty' }), '[data-testid="op-banner"][data-stop-reason="empty"]');
    assert.equal(tid('x', { name: 'a"b' }), '[data-testid="x"][data-name="a\\"b"]');
  });
});

describe('selectors: chord', () => {
  it('converts the WebdriverIO shortcut notation to Playwright key strings', () => {
    assert.equal(chord('Mod+K'), 'ControlOrMeta+k', 'a capital letter would imply Shift');
    assert.equal(chord('Mod+k'), 'ControlOrMeta+k');
    assert.equal(chord('Mod+Shift+K'), 'ControlOrMeta+Shift+k');
    assert.equal(chord('Mod+Enter'), 'ControlOrMeta+Enter');
    assert.equal(chord('Mod+1'), 'ControlOrMeta+1');
    assert.equal(chord('Escape'), 'Escape');
    assert.equal(chord('Shift+ArrowDown'), 'Shift+ArrowDown');
    assert.equal(chord('F2'), 'F2');
    assert.equal(chord('/'), '/');
    assert.equal(chord('S'), 's');
    assert.equal(chord('Ctrl+Tab'), 'Control+Tab');
    assert.throws(() => chord('Hyper+K'), /unknown modifier/);
    assert.throws(() => chord('Mod+Nope'), /unknown key/);
  });
});
