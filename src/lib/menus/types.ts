// Targets of context menus and closed identifiers .
import type { BranchInfo, FileChange, FileStatus, RemoteBranchInfo, RemoteInfo, StashEntry, TagInfo } from '../ipc/types';

export type MenuId = 'commit' | 'branch' | 'remote-branch' | 'remote' | 'tag' | 'stash' | 'wip' | 'wt-file' | 'commit-file';

export const MENU_IDS: readonly MenuId[] = ['commit', 'branch', 'remote-branch', 'remote', 'tag', 'stash', 'wip', 'wt-file', 'commit-file'];

/** Closed list of `<action>` `context-menu-item-<action>` . */
export const MENU_ITEM_IDS = [
  'checkout', 'checkout-detached', 'create-branch', 'cherry-pick', 'revert', 'rebase-onto', 'interactive-rebase',
  'interactive-rebase-onto', 'merge', 'push', 'pull', 'fetch', 'open-pr', 'rename', 'delete', 'copy-sha',
  'copy-message', 'copy-name', 'copy-url', 'copy-path', 'stash-apply', 'stash-pop', 'stash-drop', 'stash-branch',
  'stash-show', 'stash-save', 'stash-paths', 'open-external', 'stage-tracked', 'stage-all', 'discard-all', 'squash', 'reset', 'resolve-ours', 'resolve-theirs',
  'create-tag', 'file-history', 'file-blame', 'delete-remote', 'reword',
] as const;

export type MenuItemId = (typeof MENU_ITEM_IDS)[number];

/** What the menu was opened on. `menu` is discrimination. */
export type MenuTarget =
  | {
      menu: 'commit';
      /** Commit we clicked on. */
      oid: string;
      /** Selected commits (contains `oid`): "Cherry-pick n commits". */
      oids: string[];
    }
  | { menu: 'branch'; branch: BranchInfo }
  | { menu: 'remote-branch'; branch: RemoteBranchInfo }
  | { menu: 'remote'; remote: RemoteInfo }
  | { menu: 'tag'; tag: TagInfo }
  | { menu: 'stash'; stash: StashEntry }
  | { menu: 'wip' }
  /** `files` = selected files (contains `file`). */
  | { menu: 'wt-file'; file: FileStatus; files?: FileStatus[] }
  /** A file in the list of a commit (or of the changes between two): `oid` is the commit the list belongs to (the newer one for two). */
  | { menu: 'commit-file'; oid: string; file: FileChange };

export type MenuTargetOf<M extends MenuId> = Extract<MenuTarget, { menu: M }>;
