# outlook-for-linux

An unofficial Microsoft Outlook client for Linux (and macOS/Windows), built with [`Electron`](https://electronjs.org/). It wraps the Outlook Web App as a standalone desktop application.

> **Maintained fork.** This is a continuation of [`mahmoudbahaa/outlook-for-linux`](https://github.com/mahmoudbahaa/outlook-for-linux) (itself a clone of [`IsmaelMartinez/teams-for-linux`](https://github.com/IsmaelMartinez/teams-for-linux)), which had not been updated for ~3 years. The fork lives at [`gj241/outlook-for-linux`](https://github.com/gj241/outlook-for-linux) and is actively maintained.

Please report bugs and questions in the [issues](https://github.com/gj241/outlook-for-linux/issues) section. PRs and suggestions are welcome.

---

![](https://img.shields.io/github/release/gj241/outlook-for-linux.svg?style=flat)
![](https://img.shields.io/github/downloads/gj241/outlook-for-linux/total.svg?style=flat)
![Build & Release](https://github.com/gj241/outlook-for-linux/actions/workflows/build.yml/badge.svg)

## Downloads

Pre-built binaries are on the [releases page](https://github.com/gj241/outlook-for-linux/releases), built for **x64 (amd64)**, **arm64 (aarch64)**, and **armv7l (armhf)**:

| Format | Linux | macOS | Windows |
|:-:|:-:|:-:|:-:|
| `deb` | amd64 · arm64 · armv7l | — | — |
| `rpm` | x86_64 · aarch64 · armv7l | — | — |
| `AppImage` | amd64 · arm64 · armv7l | — | — |
| `tar.gz` | amd64 · arm64 · armv7l | — | — |
| `snap` | amd64 · armv7l (see note) | — | — |
| `dmg` / `zip` | — | arm64 | — |
| `exe` | — | — | x64 |

For `AppImage`, we recommend [`AppImageLauncher`](https://github.com/TheAssassin/AppImageLauncher) for the best desktop experience.

> **Snap note:** The snap name `outlook-for-linux` on the Snap Store is owned by the abandoned upstream and can't be published to, so the `.snap` is shipped as a direct download from the release page. Install it with `sudo snap install outlook-for-linux_1.4.0_amd64.snap --dangerous` (the `--dangerous` flag is required because it isn't store-signed).

## Features

- **Multi-account switcher** — a draggable pill in the top-right corner lets you run several Outlook accounts at once. Each account lives on its own persistent partition, so you stay logged in to all of them and switch instantly (recently-used accounts are cached; others reload without re-signing-in). Add, rename, and remove accounts from the switcher or the tray menu.
- **New-mail notifications** — polls the unread count in the page title and raises a native desktop notification (with a sound) when new mail arrives. Uses `notify-send` with the `desktop-entry` hint so GNOME shows it correctly. Controlled by the `notifyOnNewMail` setting (on by default).
- **Linux branding** — the dock, notifications, and tray show "Outlook for Linux" (not "Electron"), with the correct icon.
- **"Open in new window" fix** — opening a message in a new window works correctly (ported from upstream PR #23).

## Starting arguments

The application uses [yargs](https://www.npmjs.com/package/yargs) for command-line arguments. See the full list (including `notifyOnNewMail`, `accountCacheSize`, `disableNotifications`, etc.) in [`app/config/README.md`](app/config/README.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to run from source and how to contribute.

## Known issues

Known issues and workarounds are in [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

## History

Read about the history of this project in [`HISTORY.md`](HISTORY.md).

## License

License: [`GPLv3`](LICENSE.md)