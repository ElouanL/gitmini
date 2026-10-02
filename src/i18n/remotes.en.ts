// Chains of 10 "Remotes": push, pull, remote management, clone. (GitHub and authentication: github.en.ts.)
export default {
  'remotes.op.push': 'Push',
  'remotes.op.pull': 'Pull',
  'remotes.op.remoteAdd': 'Add remote',
  'remotes.op.remoteRemove': "Remove remote",
  'remotes.op.clone': 'Clone',

  // Toasts
  'remotes.toast.upToDate': 'Already up to date',
  'remotes.toast.pushDone': 'Push finished',
  'remotes.toast.pullDone': 'Pull finished',
  'remotes.toast.detached': "Detached HEAD: Create a branch to push these commits.",
  'remotes.toast.behind': "{ref} is ahead: pull first",
  'remotes.toast.stashKept': "Your changes have been saved in stash@{0}",
  'remotes.toast.pullOverwritten': "These files would be overwritten: {paths}. Commit or stash these files.",
  'remotes.toast.remoteRemoved': "Remote {name} deleted",
  'remotes.toast.prOpened': 'Comparison page opened in the browser',
  'remotes.toast.cloned': "{name} cloned",

  // Forced push (confirm-dialog[data-action=force-push])
  'remotes.forcePush.title': 'Forced Push',
  'remotes.forcePush.message.one': "Rewrite {ref}? 1 commit present on the server will be replaced. If you have not rewritten the branch, cancel and make a Pull.",
  'remotes.forcePush.message.other': "Rewrite {ref}? {n} commits present on the server will be replaced. If you have not rewritten the branch, cancel and make a Pull.",
  'remotes.forcePush.confirm': 'Force push',

  // push-dialog
  'remotes.push.title': "Push {branch}",
  'remotes.push.remote': 'Remote',
  'remotes.push.remoteBranch': 'Remote branch',
  'remotes.push.setUpstream': "Set the upstream (-u)",
  'remotes.push.submit': 'Push',
  'remotes.push.cancel': 'Cancel',
  'remotes.push.error.empty': 'Enter the name of the remote branch.',
  'remotes.push.error.invalid': 'Invalid remote branch name.',

  // push-rejected-dialog
  'remotes.rejected.title': 'Push refused',
  'remotes.rejected.fastForward': "Push refused: {ref} contains commits that you don't have.",
  'remotes.rejected.stale': 'The remote branch has changed since your last fetch. Fetch, integrate the new commits, then push. Nothing was overwritten.',
  'remotes.rejected.pull': 'Pull',
  'remotes.rejected.fetch': 'Fetch',
  'remotes.rejected.cancel': 'Close',

  // pull-diverged-dialog / pull-autostash-dialog
  'remotes.diverged.title': "Diverged branches",
  'remotes.diverged.message': "{branch} and {upstream} have diverged (↑{ahead} ↓{behind}). Rebase your {ahead} commit(s) onto {upstream}?",
  'remotes.diverged.message.noCounts': "{branch} and {upstream} have diverged. Rebase your commits on {upstream}?",
  'remotes.diverged.rebase': 'Pull (rebase)',
  'remotes.autostash.title': 'Local changes',
  'remotes.autostash.message.one': "1 modified file prevents pull. Retry with autostash?",
  'remotes.autostash.message.other': "{n} modified files prevent pull. Retry with autostash?",
  'remotes.autostash.relaunch': 'Relaunch with autostash',
  'remotes.pull.cancel': 'Cancel',
  'remotes.pull.upstreamFallback': "the upstream",

  // Ajout d'un remote
  'remotes.add.title': 'Add Remote',
  'remotes.add.tab.url': 'URL',
  'remotes.add.tab.github': 'GitHub',
  'remotes.add.name': 'Name',
  'remotes.add.url': 'URL',
  'remotes.add.protocol': 'Protocol',
  'remotes.add.fetch': "Fetch branches after adding the remote",
  'remotes.add.submit': 'Add',
  'remotes.add.cancel': 'Cancel',
  'remotes.add.error.name.empty': 'Enter a remote name.',
  'remotes.add.error.name.leading-dash': 'A remote name cannot begin with "-".',
  'remotes.add.error.name.slash': 'A remote name cannot contain "/".',
  'remotes.add.error.name.invalid': 'Invalid remote name.',
  'remotes.add.error.url.empty': 'Enter the URL of the remote.',
  'remotes.add.error.url.leading-dash': "URL invalid.",
  'remotes.add.error.exists': "The {name} remote already exists.",
  'remotes.add.error.pickRepo': 'Choose a GitHub repository.',

  // Deleteession d'un remote (confirm-dialog[data-action=remote-remove])
  'remotes.remove.title': 'Remove Remote',
  'remotes.remove.message.none': "Remove the {name} Remote?",
  'remotes.remove.message.one': "Delete the {name} remote and its tracking branch?",
  'remotes.remove.message.other': "Remove the {name} remote and its {n} tracking branches?",
  'remotes.remove.confirm': 'Remove',

  // Clone
  'remotes.clone.title': "Clone a repository",
  'remotes.clone.tab.url': 'URL',
  'remotes.clone.tab.github': 'GitHub',
  'remotes.clone.url': "URL of the repository",
  'remotes.clone.protocol': 'Protocol',
  'remotes.clone.dest': 'Destination',
  'remotes.clone.dest.placeholder': 'Absolute path of folder to create',
  'remotes.clone.browse': 'Browse...',
  'remotes.clone.browseTitle': 'Choose the parent folder',
  'remotes.clone.submit': 'Clone',
  'remotes.clone.cancel': 'Cancel',
  'remotes.clone.cancelRunning': 'Cancel clone',
  'remotes.clone.running': 'Cloning in progress...',
  'remotes.clone.error.url.empty': "Enter the URL of the repository.",
  'remotes.clone.error.url.invalid': "URL invalid.",
  'remotes.clone.error.dest.empty': 'Choose the destination folder.',
  'remotes.clone.error.dest.exists': "The {path} folder is not empty.",
  'remotes.clone.error.pickRepo': 'Choose a GitHub repository.',

  // Menu: Open PR
  'remotes.menu.openPr': "Open a PR on GitHub",
} satisfies Record<string, string>;
