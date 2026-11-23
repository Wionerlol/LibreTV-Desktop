const { readFileSync, readdirSync, realpathSync, statSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function verifyRuntime(root) {
  try {
    const manifest = readJson(path.join(root, 'desktop-build.json'));
    const buildId = readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim();
    const { version } = readJson(path.join(root, 'package.json'));
    if (!buildId || buildId !== manifest.buildId || version !== manifest.version) {
      throw new Error('Runtime build identity mismatch');
    }

    for (const file of ['next.config.js', '.next/server/app-paths-manifest.json', 'public/favicon.ico']) {
      if (!statSync(path.join(root, file)).isFile()) throw new Error('Expected a runtime file');
    }
    const staticFiles = readdirSync(path.join(root, '.next', 'static'), { recursive: true });
    if (!staticFiles.some((file) => file.endsWith('.js')) || !staticFiles.some((file) => file.endsWith('.css'))) {
      throw new Error('Missing Next static assets');
    }

    const runtimeRequire = createRequire(path.join(root, 'package.json'));
    const modules = [
      'next', 'react', 'react-dom', 'next/dist/compiled/jest-worker/processChild',
      '@next/swc-win32-x64-msvc', 'sharp', '@img/sharp-win32-x64/sharp.node',
    ];
    const moduleRoot = realpathSync(path.join(root, 'node_modules'));
    for (const name of modules) {
      const relative = path.relative(moduleRoot, realpathSync(runtimeRequire.resolve(name)));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('A runtime module resolved outside the package');
      }
    }
    if (runtimeRequire('next/package.json').version !== manifest.next) {
      throw new Error('Next version mismatch');
    }
    return { manifest, runtimeRequire };
  } catch (cause) {
    throw Object.assign(new Error('LibreTV runtime validation failed', { cause }), { code: 'RUNTIME_ASSETS' });
  }
}

module.exports = { verifyRuntime };
