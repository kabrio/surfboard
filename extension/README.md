# SURFBOARD browser terminal extension

This prototype keeps the real browser in charge and adds a browser-owned terminal
tab. A Chrome Manifest V3 extension renders the terminal with xterm.js, while a
Swift Native Messaging host owns a real login shell and PTY.

## Try it in Chrome

Build both sides:

```sh
npm run build:extension
npm run build:native-host
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `extension/dist`.
4. Copy the extension ID shown by Chrome.
5. Install the native host for that development ID:

   ```sh
   npm run install:chrome-host -- <extension-id>
   ```

6. Reload the extension and click the SURFBOARD toolbar button. Chrome opens
   the terminal in its side panel. Use `Cmd+Shift+Y` as the direct terminal-tab
   shortcut.

The native host is connection-local: every terminal page receives its own
browser process and PTY. Closing the page disconnects the host and terminates its
shell process group.

## Security boundary

The extension cannot start programs or access the shell by itself. Chrome
launches the separately installed native host, whose manifest is restricted to
the exact extension ID supplied during installation. Native messages are
length-framed JSON, and terminal bytes are base64-encoded to preserve arbitrary
UTF-8 and control sequences.

This is development-only infrastructure. A production release needs signed
distribution for the host and extension, host updates, an explicit user
permission/onboarding screen, command auditing controls, and Chrome/Safari
packaging.

## Scope

The prototype deliberately does not replace browser chrome, intercept normal
navigation, manage browser history, or embed an AppKit view into Chrome. It
provides a terminal tab or side panel while leaving browser gestures, Reader,
favicons, profiles, shortcuts, and existing extensions untouched.
