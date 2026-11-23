import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const appPath = path.resolve(
  'out',
  `SURFBOARD-${process.platform}-${process.arch}`,
  process.platform === 'darwin'
    ? 'SURFBOARD.app/Contents/MacOS/surfboard'
    : 'surfboard',
);

if (!existsSync(appPath)) {
  throw new Error(
    `Packaged app not found at ${appPath}. Run npm run package first.`,
  );
}

const child = spawn(appPath, ['--self-test'], {
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const timeout = setTimeout(() => {
  child.kill('SIGTERM');
  throw new Error('Packaged Surfboard self-test timed out');
}, 30_000);

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});

child.on('error', (error) => {
  clearTimeout(timeout);
  throw error;
});
child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  if (code !== 0 || signal) {
    throw new Error(
      `Packaged Surfboard self-test failed (code=${code}, signal=${signal})\n${output}`,
    );
  }
  if (!output.includes('"ok":true')) {
    throw new Error(`Packaged self-test did not report success:\n${output}`);
  }
  console.log('Packaged Surfboard self-test passed.');
});
