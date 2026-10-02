// Flow strings "cherry-pick / revert" (09).
export default {
  'pick.menu.cherryPick.one': 'Cherry-pick this commit',
  'pick.menu.cherryPick.other': "Cherry-pick {n} commits",
  'pick.menu.revert.one': 'Revert this commit',
  'pick.menu.revert.other': "Revert {n} commits",

  'pick.action.cherry-pick': "Cherry-pick of the selection",
  'pick.action.revert': 'Revert selection',
  'pick.disabled.noSelection': 'Select at least one commit',
  'pick.disabled.head': "The selection contains HEAD",

  'pick.op.cherry-pick.one': "Cherry-pick a commit",
  'pick.op.cherry-pick.other': "Cherry-pick {n} commits",
  'pick.op.revert.one': 'Revert of a commit',
  'pick.op.revert.other': "Revert of {n} commits",

  'pick.done.cherry-pick.one': "{n} commit Cherry-picked on {branch}",
  'pick.done.cherry-pick.other': "{n} commits Cherry-picked on {branch}",
  'pick.done.revert.one': "{n} commit reverted on {branch}",
  'pick.done.revert.other': "{n} commits reverted on {branch}",

  // Dialogue « parent principal »
  'pick.mainline.title.cherry-pick': 'Cherry-pick of a merge commit',
  'pick.mainline.title.revert': 'Revert of a merge commit',
  'pick.mainline.merges': "Selected merge commits",
  'pick.mainline.parent': "Mainline parent",
  'pick.mainline.option': "Parent {n} — {sha} \"{summary}\"{refs}",
  'pick.mainline.option.noSummary': "Parent {n} — {sha}{refs}",
  'pick.mainline.option.generic': "Parent {n}",
  'pick.mainline.forced': "Parent 1 is required when the selection contains both merges and regular commits.",
  'pick.mainline.recordOrigin': 'Add the line "(cherry picked from commit ...)" (-x)',
  'pick.mainline.revertWarning': "Reverting a merge keeps its history: merging this branch again will not reapply these changes unless you revert this revert.",
  'pick.mainline.confirm.cherry-pick': 'Cherry-pick',
  'pick.mainline.confirm.revert': 'Revert',
  'pick.mainline.cancel': 'Cancel',

  // Erreurs propres au flux
  'pick.error.alreadyInHead.one': "{n} commit is already in {branch}: nothing to cherry-pick.",
  'pick.error.alreadyInHead.other': "{n} commits are already in {branch}: nothing to cherry-pick.",
  'pick.error.notInHead': "Only commits in the current branch can be reverted.",
  'pick.error.noHead': 'No commit on the current branch.',

  // Confirmation of abandonment (09 "Operation Banner": "Abort"; only the 2nd sentence depends on the number of commits applied)
  'pick.abort.confirm.none': "Abort the {kind}?",
  'pick.abort.confirm.one': "Abort the {kind}? The commit already applied by this operation will be removed.",
  'pick.abort.confirm.other': "Abort the {kind}? The {n} commits already applied by this operation will be removed.",
  'pick.abort.confirm.stale': "Clean up incomplete cherry-pick/revert state? No commits will be removed.",

  'pick.abort.headMoved': "HEAD moved during the operation: the state was cleaned up without resetting HEAD.",
} satisfies Record<string, string>;
