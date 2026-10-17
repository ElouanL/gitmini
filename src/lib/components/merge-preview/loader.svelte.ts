// Loads a `merge_preview` for one dialog or menu. A newer request or a `reset` makes any answer still in flight
// obsolete, so a slow preview of a previous branch never shows against the current one.
import { commands } from '$lib/ipc/commands';
import type { MergePreview } from '$lib/ipc/types';

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; preview: MergePreview }
  /** The preview is a courtesy: when it fails the merge itself stays available, so no error is raised. */
  | { status: 'failed' };

export class MergePreviewLoader {
  state = $state.raw<PreviewState>({ status: 'idle' });
  private latest = 0;

  async load(repoId: number, ref: string): Promise<void> {
    const mine = ++this.latest;
    this.state = { status: 'loading' };
    try {
      const preview = await commands.mergePreview({ repoId, ref });
      if (mine === this.latest) this.state = { status: 'ready', preview };
    } catch {
      if (mine === this.latest) this.state = { status: 'failed' };
    }
  }

  reset(): void {
    this.latest++;
    this.state = { status: 'idle' };
  }
}

/** The answer, if there is one. */
export function readyPreview(s: PreviewState): MergePreview | null {
  return s.status === 'ready' ? s.preview : null;
}
