import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const runCodesign = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    execFile('codesign', args, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `codesign failed: ${error.message}${stdout || stderr ? `\n${stdout}${stderr}` : ''}`,
          ),
        );
        return;
      }
      resolve();
    });
  });

const config: ForgeConfig = {
  packagerConfig: {
    executableName: 'surfboard',
    asar: {
      unpack: '**/node_modules/node-pty/**',
    },
    ignore: (file) =>
      Boolean(
        file &&
        !file.startsWith('/.vite') &&
        file !== '/package.json' &&
        file !== '/node_modules' &&
        file !== '/node_modules/node-pty' &&
        file !== '/node_modules/node-addon-api' &&
        !file.startsWith('/node_modules/node-pty/') &&
        !file.startsWith('/node_modules/node-addon-api/'),
      ),
  },
  rebuildConfig: {
    force: true,
  },
  hooks: {
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform !== 'darwin') return;

      const appPaths: string[] = [];
      for (const outputPath of outputPaths) {
        if (outputPath.endsWith('.app')) {
          appPaths.push(outputPath);
          continue;
        }
        const entries = await readdir(outputPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.endsWith('.app')) {
            appPaths.push(path.join(outputPath, entry.name));
          }
        }
      }
      if (appPaths.length === 0) {
        throw new Error(
          `Forge did not produce a macOS app bundle: ${outputPaths.join(', ')}`,
        );
      }

      for (const appPath of appPaths) {
        await runCodesign(['--force', '--deep', '--sign', '-', appPath]);
        await runCodesign(['--verify', '--deep', '--strict', appPath]);
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
        {
          entry: 'src/terminal/pty-worker.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
