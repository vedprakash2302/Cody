# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Windows work-account sign-in

For Microsoft sites that require a managed device, enable **Windows work-account
sign-in** in **Settings → Integrations → Browser** on the Windows machine whose
browser tabs need it. Tabs use the work account of the Windows machine they run
on, which for a remote environment is the host, not the device you are viewing
from:

- Tabs the desktop app shows directly use that device's account.
- Tabs on a WSL backend the desktop app started use the account of the Windows
  machine running WSL. They pick up a change to the setting the next time Cody
  starts that backend.
- Environments not started by the Windows desktop app, such as a Linux server,
  cannot use it.

That machine must meet your organization's access requirements. Sites that
require a corporate network still need your VPN.

This is off by default and applies to all persistent browser profiles, including
agent browsing. Incognito profiles do not use it. Turning it off stops Windows
SSO for new requests but does not sign out website sessions. Sign out on the site
or clear the browser profile's cookies to remove those sessions.
