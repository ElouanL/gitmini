// Auto-fetch (Settings and the "Pull" toast that follows a background fetch).
export default {
  'settings.fetchAuto': 'Fetch automatically',
  'settings.fetchAuto.off': 'Never',
  'settings.fetchAuto.2': 'Every 2 minutes',
  'settings.fetchAuto.5': 'Every 5 minutes',
  'settings.fetchAuto.15': 'Every 15 minutes',
  'settings.fetchAuto.30': 'Every 30 minutes',
  'settings.fetchAuto.hint': 'Fetches all remotes of the open repository while the gitmini window is visible, then offers to pull. It never asks for a password: a failure is shown once, with a button to fetch by hand.',

  'autoFetch.toast.title': 'New commits on {ref}',
  'autoFetch.toast.titleRepo': '{repo}: new commits on {ref}',
  'autoFetch.toast.message.one': '{branch} is 1 commit behind {ref}.',
  'autoFetch.toast.message.other': '{branch} is {n} commits behind {ref}.',
  'autoFetch.toast.pull': 'Pull',
  'autoFetch.failed.title': 'Automatic fetch failed',
  'autoFetch.failed.titleRepo': '{repo}: automatic fetch failed',
};
