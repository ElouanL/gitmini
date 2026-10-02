// Chains of the "branch" stream (06): creation, checkout, renaming, deletion.
export default {
  //
  'branches.op.create': "Create branch",
  'branches.op.checkout': 'Checkout',
  'branches.op.rename': "Rename branch",
  'branches.op.delete': "Delete branch",

  // - - - Menu entries
  'branches.menu.rename': 'Rename...',
  'branches.menu.delete': "Remove",

  // - - - Validation of names (06 "Validation of names")
  'branches.name.reason.leading-dash': "can't start with \"-\"",
  'branches.name.reason.leading-slash': "can't start with \"/\"",
  'branches.name.reason.trailing-slash': "cannot end with \"/\"",
  'branches.name.reason.double-slash': "cannot contain \"//\"",
  'branches.name.reason.double-dot': 'cannot contain ".."',
  'branches.name.reason.forbidden-char': "\"{char}\" is prohibited",
  'branches.name.reason.control-char': "Control character prohibited",
  'branches.name.reason.at-brace': "cannot contain \"@{\"",
  'branches.name.reason.lone-at': "can't be @",
  'branches.name.reason.trailing-dot': 'cannot end with "."',
  'branches.name.reason.lock-suffix': 'cannot end with ".lock"',
  'branches.name.reason.component-dot': 'a segment cannot start with "."',
  'branches.name.reason.head': "HEAD is reserved",
  'branches.name.invalid': 'Invalid branch name: {reason}.',
  'branches.name.exists': "A {name} branch already exists.",
  'branches.name.blockedBy': "The \"{blockedBy}\" branch already exists and blocks \"{name}\".",

  // - - - Create a branch
  'branches.create.title': 'Create a branch',
  'branches.create.name': 'Branch name',
  'branches.create.namePlaceholder': "feature/my-branch",
  'branches.create.startPoint': 'Starting point',
  'branches.create.startPoint.head': 'HEAD ({name})',
  'branches.create.startPoint.detached': "Detached HEAD @ {sha}",
  'branches.create.checkout': 'Switch to the new branch',
  'branches.create.submit': 'Create',
  'branches.create.cancel': 'Cancel',
  'branches.create.done': "Branch \"{name}\" created.",

  //
  'branches.rename.title': "Rename branch \"{name}\"",
  'branches.rename.label': 'New name',
  'branches.rename.submit': 'Rename',
  'branches.rename.cancel': 'Cancel',
  'branches.rename.upstreamKept': "The upstream \"{upstream}\" is retained.",
  'branches.rename.done': "Branch \"{old}\" renamed to \"{name}\".",
  'branches.rename.gone': "The branch \"{name}\" no longer exists.",

  // ── Checkout
  'branches.checkout.target.detached': "the commit {sha}",
  'branches.checkout.target.branch': "the branch \"{name}\"",
  'branches.checkoutDirty.title': "Local changes in progress",
  'branches.checkoutDirty.message': "Your local changes prevent you from switching to {target}. Files concerned:",
  'branches.checkoutDirty.noFiles': 'Tracked changes prevent checkout.',
  'branches.checkoutDirty.reapply': 'Reapply my changes after checkout',
  'branches.checkoutDirty.stash': 'Stash and switch',
  'branches.checkoutDirty.cancel': 'Cancel',
  'branches.checkoutDirty.kept': "Your changes are in the stash stash@{0}.",
  'branches.checkoutDirty.conflict': 'Reapplication of your changes has caused conflicts: they remain in stash@{0}.',
  'branches.checkoutRemote.title': 'Name of local branch',
  'branches.checkoutRemote.message': "A local branch \"{name}\" already exists and does not follow \"{ref}\". Choose another name for the local branch:",
  'branches.checkoutRemote.submit': 'Create and switch',
  'branches.checkoutRemote.cancel': 'Cancel',

  // ── Deleteession
  'branches.delete.done': "Branch \"{name}\" deleted (was at {sha}).",
  'branches.deleteForce.title': 'Branch not merged',
  'branches.deleteForce.message.one': "The \"{name}\" branch contains {n} commit missing from its upstream (or HEAD). Delete anyway?",
  'branches.deleteForce.message.other': "The \"{name}\" branch contains {n} commits missing from its upstream (or HEAD). Delete anyway?",
  'branches.deleteForce.confirm': 'Delete anyway',
  'branches.deleteForce.cancel': 'Cancel',

  // ── Erreurs propres au flux
  'branches.error.checkedOutElsewhere': "Branch \"{name}\" is checked out in {path}.",
  'branches.error.checkedOutElsewhere.generic': 'This branch is checked out in {path}.',
  'branches.error.gone': "The branch \"{name}\" no longer exists.",
} satisfies Record<string, string>;
