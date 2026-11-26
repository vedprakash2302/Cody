# Import browser sessions

Import cookies from another browser into the desktop app's [preview browser](./browser.md) so you can reuse existing signed-in sessions.

## Import a profile

1. Close the source browser.
2. Open **Settings → Browser → Browser profiles → Add profile** and choose a browser under **Import from**.
3. Allow any OS keyring unlock prompt.

This is a one-time copy—later login changes stay separate, and some sites may still require signing in again.

## Platform notes

- **macOS (Safari)**: Requires temporary **Full Disk Access** (grant in System Settings, quit/reopen T3 Code if macOS requires it, then reopen the import wizard). You can revoke Full Disk Access afterward.
- **Windows**: Supports Firefox, Zen, and Helium profiles using standard encryption. Other Chromium browsers use app-bound encryption and cannot be imported.
- Partitioned cookies are skipped on all platforms. Administrators can disable cookie import via [managed policy](./managed-policy.md#other-capabilities).

## Windows work-account sign-in

For Microsoft sites that require a managed device, enable **Windows work-account
sign-in** in **Settings → Browser** on the Windows machine whose browser tabs need
it. Tabs use the work account of the Windows machine they run on:

- Tabs the desktop app shows directly use that device's account. This includes
  tabs you open for a remote environment, which run on the device you are
  viewing from.
- Tabs on a WSL backend the desktop app started use the account of the Windows
  machine running WSL. These are the tabs agents open, and tabs you move there
  with **Open in <environment>'s browser** in the tab's More menu. They pick up
  a change to the setting the next time Cody starts that backend.
- Environments not started by the Windows desktop app, such as a Linux server,
  cannot use it.

That machine must meet your organization's access requirements. Sites that
require a corporate network still need your VPN.

This is off by default and applies to all persistent browser profiles, including
agent browsing. Incognito profiles do not use it. Turning it off stops Windows
SSO for new requests but does not sign out website sessions. Sign out on the site
or clear the browser profile's cookies to remove those sessions.
