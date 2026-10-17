// Strings of the discarded files recovery: the drawer next to the reflog, restore, and the toast after a discard.
export default {
  'trash.tabs.label': 'Recovery',
  'trash.tab.reflog': 'Reflog',
  'trash.tab.discarded': 'Discarded',

  'trash.action.show': 'Show / hide discarded files',

  'trash.title': 'Discarded files',
  'trash.close': 'Close discarded files',
  'trash.loading': 'Loading...',
  'trash.error': 'Could not read the discarded files.',
  'trash.empty': 'Nothing discarded yet.',
  'trash.emptyHint': 'Files you discard, or replace while resolving a conflict, are kept here so you can bring them back.',
  'trash.retention': 'Contents are kept as Git objects. Git may clean them up after about two weeks.',

  'trash.restore': 'Restore',
  'trash.restore.aria': 'Restore {path}',
  'trash.restore.title': 'Write this version back into the working tree',

  'trash.source.discard': 'Discarded',
  'trash.source.discard-hunk': 'Changes discarded',
  'trash.source.resolve': 'Replaced while resolving',
  'trash.source.restore': 'Replaced by a restore',
  'trash.kind.executable': 'executable',
  'trash.kind.symlink': 'link',

  'trash.op.restore': 'Restore discarded files',
  'trash.restore.done': 'Restored {path}.',
  'trash.restore.done.replaced': 'Restored {path}. The version it replaced is in the list.',
  'trash.restore.done.many.one': 'Restored {n} file.',
  'trash.restore.done.many.other': 'Restored {n} files.',
  'trash.restore.gone': 'The saved content of {path} is gone: Git has cleaned it up.',
  'trash.restore.unavailable': 'This discarded file is no longer in the list.',
  'trash.restore.blocked': 'Cannot restore {path}: a file or folder is in the way.',

  'trash.toast.files.one': 'Discarded {n} file.',
  'trash.toast.files.other': 'Discarded {n} files.',
  'trash.toast.all': 'Discarded all changes.',
  'trash.toast.hunk': 'Discarded changes in {path}.',
  'trash.toast.recover': 'Recover',
} satisfies Record<string, string>;
