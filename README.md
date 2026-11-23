# SURFBOARD

SURFBOARD is an Electron desktop workspace where Chromium browser tabs and real terminal sessions have equal status. A local, opt-in MCP endpoint lets a coding agent inspect and operate the active browser without giving it shell or filesystem access.

## Stack

- Electron 45 + TypeScript + Electron Forge/Vite
- React for the shell UI and xterm.js for terminal rendering
- `WebContentsView` with Chromium DevTools Protocol for browser automation
- `node-pty` in an Electron utility process for real PTYs
- The official TypeScript MCP SDK for local Streamable HTTP control

The first target is macOS. Browser, terminal, IPC, and process code is kept platform-neutral so Linux packaging can reuse the same core. Windows is not currently shipped.

## Development

Requirements: Node 22+ and the native toolchain needed by `node-pty` (Xcode Command Line Tools on macOS).

```sh
npm install
npm start
```

The default workspace opens an `https://example.com` browser tab and a login terminal. Browser tabs are Node-free Chromium views; SURFBOARD's own React shell and preload expose only narrow typed APIs.

## Verify

```sh
npm run typecheck
npm run lint
npm test
npm run package
npm run test:package
```

`test:package` launches the packaged `.app` with a deterministic localhost fixture. It verifies that Chromium/CDP, screenshots, click dispatch, and a real `node-pty` shell all work inside the ASAR-packaged application.

## MCP agent access

Agent access is disabled by default. Enable it from the bottom status bar, then copy the generated MCP configuration. It contains a random per-user bearer capability and the active loopback URL:

```json
{
  "mcpServers": {
    "surfboard": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": {
        "Authorization": "Bearer <capability>"
      }
    }
  }
}
```

The local endpoint exposes typed page inspection, screenshot, navigation, click, typing, scrolling, waiting, console, and network tools. It intentionally does not expose terminal input/output, shell execution, arbitrary filesystem access, cookies, or raw CDP.

Audit entries are written to `agent-audit.ndjson` under Electron's user-data directory. Page form values and network bodies are not logged by default.

## Packaging notes

Forge only bundles Vite sources by default. `node-pty` and `node-addon-api` are explicitly retained, `node-pty` is rebuilt for Electron, and the entire PTY package (including `spawn-helper`) is unpacked from ASAR. Production fuses disable `RunAsNode`, Node CLI inspection, and loading the app from outside ASAR.

The current build is development-signed/personal-use. Add organization signing/notarization before distributing macOS binaries publicly.

## Downloads

The public download site is served from `docs/` through GitHub Pages. Tagged
releases trigger macOS and Linux builds, upload package checksums, and become
available at:

https://kabrio.github.io/surfboard/
