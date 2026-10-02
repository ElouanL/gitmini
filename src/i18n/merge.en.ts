// Chains of the "merge" flow (06 "Merge").
export default {
  'merge.op': 'Merge',
  'merge.drag.label': "Merge the dragged branch into the current branch",
  'merge.menu.merge': "Merge \"{name}\" in \"{head}\"",

  'merge.title': "Merge",
  'merge.loading': 'Analysis of branches...',
  'merge.summary.one': "Merge \"{ref}\" ({n} commit) in \"{head}\"",
  'merge.summary.other': "Merge \"{ref}\" ({n} commits) in \"{head}\"",
  'merge.summary.upToDate': "Merge \"{ref}\" in \"{head}\"",
  'merge.mode.label': "Merge mode",
  'merge.mode.ff': 'Fast forward if possible',
  'merge.mode.no-ff': 'Always create a merge commit',
  'merge.mode.ff-only': 'Fast-forward only',
  'merge.mode.ff-only.disabled': "impossible: branches have diverged",
  'merge.message.label': "Merge commit message",

  'merge.hint.upToDate': 'Already up to date',
  'merge.hint.ff.one': "Fast-forward by {n} commit possible",
  'merge.hint.ff.other': "Fast-forward by {n} commits possible",
  'merge.hint.diverged': "Merge commit required",

  'merge.error.dirty': "Commit or stash your changes before merging.",
  'merge.error.diverged': "Fast forward impossible: branches have diverged.",
  'merge.error.gone': "The branch \"{ref}\" no longer exists.",
  'merge.stash': "Stash my changes",

  'merge.submit': "Merge",
  'merge.cancel': 'Cancel',

  'merge.done.ff': "\"{head}\" advanced to \"{ref}\" (fast-forward)",
  'merge.done.merged': "\"{ref}\" in \"{head}\"",
} satisfies Record<string, string>;
