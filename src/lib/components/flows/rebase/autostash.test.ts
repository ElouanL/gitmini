import { describe, expect, it } from 'vitest';
import { autostashRetained } from './autostash';

describe('autostashRetained', () => {
  it("launch (the stash has just been created): retained if the list has grown", () => {
    expect(autostashRetained(0, 1, false)).toBe(true); // Conflict reapplication: stash@{0} remains
    expect(autostashRetained(2, 3, false)).toBe(true);
    expect(autostashRetained(2, 2, false)).toBe(false); // created and then depiled: unchanged list
    expect(autostashRetained(0, 0, false)).toBe(false); // nothing has been stashes
  });

  it("resume (stash already existed during the break): retained if the list did not decrease", () => {
    expect(autostashRetained(1, 1, true)).toBe(true); // conflict reapplication: stash remains
    expect(autostashRetained(1, 0, true)).toBe(false); // re-applied and then depilated
    expect(autostashRetained(3, 2, true)).toBe(false);
  });
});
