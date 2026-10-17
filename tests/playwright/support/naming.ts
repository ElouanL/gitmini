// Names derived from a test, pure (unit-tested in naming.test.ts).

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { TestInfo } from '@playwright/test';

/** Scenario id from a `<id>.<fixture>.spec.ts` file name (`ui-12.with-remote.spec.ts` gives `UI-12`), else the file stem. */
export function scenarioId(file: string): string {
  const name = basename(file);
  const m = /^([a-z]+-\d{2})\./.exec(name);
  return m ? (m[1] as string).toUpperCase() : name.replace(/\.spec\.ts$/, '');
}

/**
 * Artifact folder name of a test, unique inside a run: `UI-12--prefixes-become-folders-1a2b3c` (scenario id, readable slug of
 * the title without its own `UI-12` prefix, short hash of the full title so that two long titles never collide), plus
 * `--retryN` / `--repeatN` when relevant.
 */
export function sessionId(testInfo: Pick<TestInfo, 'file' | 'title' | 'retry' | 'repeatEachIndex'>): string {
  const id = scenarioId(testInfo.file);
  const own = `${id.toLowerCase()}-`;
  let slug = testInfo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.startsWith(own)) slug = slug.slice(own.length);
  const hash = createHash('sha1').update(testInfo.title).digest('hex').slice(0, 6);
  const suffix = `${testInfo.retry > 0 ? `--retry${testInfo.retry}` : ''}${testInfo.repeatEachIndex > 0 ? `--repeat${testInfo.repeatEachIndex}` : ''}`;
  return `${id}--${slug.slice(0, 40).replace(/-+$/, '')}-${hash}${suffix}`;
}
