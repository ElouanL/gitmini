# Security

Use GitHub's private vulnerability reporting feature (**Security → Report a vulnerability**) for security issues. If that feature is not enabled, contact a maintainer privately through their GitHub profile before sharing sensitive details. Do not post credentials, exploit details or private repository data in a public issue.

Include the affected version, platform, reproduction steps and impact. Only test against repositories and systems you control. The latest release and the main branch are the primary maintenance targets.

The desktop WebView has privileged access through a restricted IPC interface. External URLs and Git write operations are handled by the backend. The HTTP development bridge must remain bound to loopback and is not a production server.

Update packages are verified with the configured Tauri public key before installation. Ad hoc macOS signing and unsigned Windows installers do not provide operating-system publisher verification; this is separate from updater package authentication.

Dependency checks reject known vulnerabilities. `deny.toml` documents six specific maintenance-notice exceptions for indirect dependencies in Tauri's GTK3 and urlpattern stacks. These packages have no patched releases; review the linked RustSec notices when updating Tauri and remove the exceptions once upstream replaces them.
