import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extensionId = process.argv[2];
if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error(
    'Usage: npm run install:chrome-host -- <32-character Chrome extension ID>',
  );
  process.exit(1);
}

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostPackage = join(extensionRoot, 'native-host');
const build = spawnSync(
  'swift',
  ['build', '--package-path', hostPackage, '-c', 'release'],
  { stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const builtHost = join(
  hostPackage,
  '.build',
  'release',
  'surfboard-native-host',
);
const installRoot = join(
  homedir(),
  'Library',
  'Application Support',
  'SURFBOARD',
  'NativeMessaging',
);
const installedHost = join(installRoot, 'surfboard-native-host');
const manifestRoot = join(
  homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts',
);
const manifestPath = join(manifestRoot, 'com.kabrio.surfboard_terminal.json');

mkdirSync(installRoot, { recursive: true });
mkdirSync(manifestRoot, { recursive: true });
copyFileSync(builtHost, installedHost);
chmodSync(installedHost, 0o755);

writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: 'com.kabrio.surfboard_terminal',
      description: 'SURFBOARD native terminal host',
      path: installedHost,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

console.log(`Installed native host: ${installedHost}`);
console.log(`Registered Chrome manifest: ${manifestPath}`);
console.log('Reload the SURFBOARD extension in chrome://extensions.');
