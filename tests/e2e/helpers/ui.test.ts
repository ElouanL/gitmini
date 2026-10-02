import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Key, MOD, cdpKeyEvent, chord, tid } from '../../support/ui';

describe("ui.ts: selectors and shortcuts (pure parts)", () => {
  it("tid accepts filters of 13 and attributes", () => {
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

  it("chord converts shortcuts to WebDriver keys", () => {
    assert.deepEqual(chord('Mod+K'), [MOD, 'k'], "a capital letter would sink Shift");
    assert.deepEqual(chord('Mod+k'), [MOD, 'k']);
    assert.deepEqual(chord('Mod+Shift+K'), [MOD, Key.Shift, 'k']);
    assert.deepEqual(chord('Mod+Enter'), [MOD, Key.Enter]);
    assert.deepEqual(chord('Escape'), [Key.Escape]);
    assert.deepEqual(chord('Shift+ArrowDown'), [Key.Shift, Key.ArrowDown]);
    assert.deepEqual(chord('F2'), [Key.F2]);
    assert.deepEqual(chord('s'), ['s']);
    assert.deepEqual(chord('S'), ['s']);
    assert.throws(() => chord('Hyper+K'), /modifier unknown/);
    assert.throws(() => chord('Mod+Nope'), /unknown key/);
  });

  it("cdpKeyEvent: modifier + digit or punctuation pass through CDP (chromedriver sends \"#\" for Mod+3), the rest does not", () => {
    const bit = MOD === Key.Command ? 4 : 2;
    assert.deepEqual(cdpKeyEvent('Mod+3'), { key: '3', code: 'Digit3', windowsVirtualKeyCode: 51, modifiers: bit });
    assert.deepEqual(cdpKeyEvent('Mod+,'), { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: bit });
    assert.equal(cdpKeyEvent('Mod+Shift+1')?.modifiers, bit | 8);
    assert.equal(cdpKeyEvent('Mod+k'), null);
    assert.equal(cdpKeyEvent('Mod+Enter'), null);
    assert.equal(cdpKeyEvent('3'), null, "without modifier, normal strike is suitable");
    assert.equal(cdpKeyEvent('Escape'), null);
  });

  it("MOD is worth Cmd under macOS and Ctrl elsewhere", () => {
    assert.equal(MOD, process.platform === 'darwin' ? Key.Command : Key.Control);
  });
});
