// The toast that follows a discard. The discard flows call `announceDiscard`; the logic loads on first use so that they
// carry none of it (initial JS budget).
import { trackActivity } from '$lib/activity';
import type { Session } from '$lib/stores/session.svelte';
import type { DiscardAnnouncement } from './trash-logic';

/** Says what was thrown away and offers to open the discarded files. Fire and forget. */
export function announceDiscard(what: DiscardAnnouncement, owner?: Session): void {
  void trackActivity('chunk:trash-run', import('./run')).then((m) => m.announceDiscard(what, owner));
}
