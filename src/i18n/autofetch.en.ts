// Auto-fetch (Settings and the "Pull" toast that follows a background fetch).
export default {
  'settings.fetchAuto': 'Fetch automatically',
  'settings.fetchAuto.off': 'Never',
  'settings.fetchAuto.5': 'Every 5 minutes',
  'settings.fetchAuto.15': 'Every 15 minutes',
  'settings.fetchAuto.30': 'Every 30 minutes',
  'settings.fetchAuto.hint': "Fetches all remotes of the open repository while the gitmini window is visible and idle, then offers to pull. It never asks for a password, and retries about once an hour after an authentication error.",

  'autoFetch.toast.title': 'New commits on {ref}',
  'autoFetch.toast.titleRepo': '{repo}: new commits on {ref}',
  'autoFetch.toast.message.one': '{branch} is 1 commit behind {ref}.',
  'autoFetch.toast.message.other': '{branch} is {n} commits behind {ref}.',
  'autoFetch.toast.pull': 'Pull',
};
