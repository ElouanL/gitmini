// Contract of the 66 commands: one wrapper per order, exact name, arguments transmitted as is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMAND_NAMES, commands, newOpId, type CommandKey } from './commands';
import { createFakeTransport } from '../test/fake-transport';
import { resetAll } from '../test/reset';

beforeEach(resetAll);

function rustCommandList(): string[] {
  const src = readFileSync(join(__dirname, '../../../crates/gitmini-core/src/dispatch.rs'), 'utf8');
  const block = src.slice(src.indexOf('pub const COMMANDS'), src.indexOf('];', src.indexOf('pub const COMMANDS')));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe('commands.ts', () => {
  it("exactly displays the 66 backend commands", () => {
    const names = Object.values(COMMAND_NAMES).sort();
    expect(names).toHaveLength(66);
    expect(new Set(names).size).toBe(66);
    expect(names).toEqual([...rustCommandList()].sort());
  });

  it("each key of `commands` has its contract name", () => {
    expect(Object.keys(commands).sort()).toEqual(Object.keys(COMMAND_NAMES).sort());
  });

  it("each wrapper invokes the right command with the single argument object", async () => {
    const fake = createFakeTransport();
    fake.install();
    for (const key of Object.keys(COMMAND_NAMES) as CommandKey[]) {
      fake.on(COMMAND_NAMES[key], () => null);
      const args = { repoId: 1, marker: key };
      await (commands[key] as (a?: object) => Promise<unknown>)(args);
      const last = fake.calls[fake.calls.length - 1]!;
      expect(last.command).toBe(COMMAND_NAMES[key]);
    }
    // Unarguable commands send `{}`.
    await commands.appInfo();
    expect(fake.calls[fake.calls.length - 1]).toEqual({ command: 'app_info', args: {} });
    await commands.stagePaths({ repoId: 3, paths: 'all' });
    expect(fake.calls[fake.calls.length - 1]).toEqual({ command: 'stage_paths', args: { repoId: 3, paths: 'all' } });
  });

  it("a rejection of the transport is an AppError", async () => {
    const fake = createFakeTransport().install();
    fake.reject('status_get', { code: 'NOT_FOUND', message: "Folder not found", details: { what: 'workdir' } });
    await expect(commands.statusGet({ repoId: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND', details: { what: 'workdir' } });
  });

  it("newOpId produces separate UUID v4", () => {
    const a = newOpId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newOpId()).not.toBe(a);
  });
});
