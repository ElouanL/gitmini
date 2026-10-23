# Privacy Policy

_Last updated: October 23, 2026_

gitmini is a desktop Git client. This policy explains what data it handles and where that data goes.

## Summary

gitmini does not collect, sell or share any personal data. It has no analytics, no telemetry, no advertising and no account with its developer. Everything it handles stays on your computer, except what it sends to the Git remotes and GitHub services you choose to use.

## Data stored on your computer

- **Your repositories.** gitmini reads and modifies the Git repositories you open, only on your device.
- **Settings and recent repositories.** Stored locally in the application's data folder.
- **GitHub token (optional).** If you sign in to GitHub, the access token is stored in your operating system's credential store (Windows Credential Manager, macOS Keychain or the Secret Service on Linux). It is never written to logs: tokens are masked in log files and crash reports.
- **Logs and crash reports.** If gitmini crashes, a crash report is written to the application's log folder on your computer. It is never sent anywhere automatically.

You can delete this data at any time by signing out of GitHub in gitmini, uninstalling the application and removing its data folder.

## Network connections

gitmini connects to the network only to:

- **Contact your Git remotes** (for example GitHub, GitLab or your own server) when you fetch, pull, push or clone, and to fetch automatically every two minutes while a repository window is visible. These connections use the remote URLs and credentials configured in your repositories.
- **Use the GitHub API** (`github.com` and `api.github.com`) if you sign in to GitHub: to sign in, list your repositories and create pull requests. These requests are covered by [GitHub's Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

gitmini does not contact any server operated by its developer.

## Children

gitmini is a developer tool and is not directed at children.

## Changes

Any change to this policy will be published in this file, with a new date at the top.

## Contact

Questions about this policy: open an issue at https://github.com/ElouanL/gitmini/issues
