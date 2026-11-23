const { createHash } = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { Arch, Platform, build } = require('electron-builder');
const { verifyRuntime } = require('./runtime.cjs');
const tools = require('./package.json');

const repo = path.resolve(__dirname, '..');
const evidence = path.join(repo, 'artifacts', 'validation');
const moduleInputs = ['package.json', 'package-lock.json'];
const sourceInputs = [
  ...moduleInputs, 'public', 'src', 'next.config.ts', 'next-env.d.ts', 'tsconfig.json',
  'eslint.config.mjs', 'postcss.config.mjs', 'tailwind.config.ts',
];
const mainInputs = ['main.cjs', 'preview-server.cjs', 'runtime.cjs'];
const executableName = 'LibreTV Desktop.exe';
const offline = process.argv.includes('--offline');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function gitHead() {
  const env = { ...process.env };
  // Some Windows sandbox shells provide a count without its corresponding entries.
  if (env.GIT_CONFIG_COUNT && !env.GIT_CONFIG_KEY_0) delete env.GIT_CONFIG_COUNT;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env, encoding: 'utf8' }).trim();
}

function runNpm(cwd, args, env) {
  console.log('npm', args.join(' '));
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, env, stdio: 'inherit',
  });
  if (result.status !== 0) throw result.error ?? new Error('npm failed with exit ' + result.status);
}

function copyInput(from, to) {
  fs.cpSync(from, to, {
    recursive: true, errorOnExist: true, force: false,
    filter: (file) => {
      const name = path.basename(file).toLowerCase();
      if (name.startsWith('.env') || name === '.ssh' || /\.(key|pem)$/.test(name)) return false;
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symbolic link in build inputs');
      return true;
    },
  });
}

function writeRuntimeConfig(source, runtime) {
  const ts = createRequire(path.join(source, 'package.json'))('typescript');
  const config = fs.readFileSync(path.join(source, 'next.config.ts'), 'utf8');
  const compiled = ts.transpileModule(config, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const javascript = compiled + '\nmodule.exports = { ...exports.default, output: undefined, outputFileTracingRoot: __dirname };\n';
  fs.writeFileSync(path.join(source, 'next.config.js'), javascript, { flag: 'wx' });
  fs.copyFileSync(path.join(source, 'next.config.js'), path.join(runtime, 'next.config.js'), fs.constants.COPYFILE_EXCL);
  // Next selects the original TypeScript config when both exist.
  fs.renameSync(path.join(source, 'next.config.ts'), path.join(path.dirname(source), 'next-config-input.ts'));
}

function peMachine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    fs.readSync(fd, dos, 0, dos.length, 0);
    const header = Buffer.alloc(6);
    fs.readSync(fd, header, 0, header.length, dos.readUInt32LE(60));
    if (dos.toString('ascii', 0, 2) !== 'MZ' || header.readUInt32LE(0) !== 0x00004550) {
      throw new Error('Expected a Windows PE executable');
    }
    return header.readUInt16LE(4);
  } finally {
    fs.closeSync(fd);
  }
}

async function packageDesktop() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Build LibreTV Desktop with native Windows x64 Node and npm.');
  }
  if (!process.env.npm_execpath) throw new Error('Run npm --prefix desktop run build.');
  const electronDist = path.join(__dirname, 'node_modules', 'electron', 'dist');
  const electronVersion = tools.devDependencies.electron;
  // Electron 44 installs its distribution lazily when imported by the build tool.
  const electronExecutable = require('electron');
  if (electronExecutable !== path.join(electronDist, 'electron.exe') ||
      fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim().replace(/^v/, '') !== electronVersion ||
      peMachine(path.join(electronDist, 'electron.exe')) !== 0x8664) {
    throw new Error('Installed Electron distribution does not match the pinned Windows x64 version');
  }

  fs.mkdirSync(evidence, { recursive: true });
  const root = fs.mkdtempSync(path.join(evidence, 'desktop-'));
  const temporary = path.resolve(process.env.LIBRETV_DESKTOP_BUILD_TEMP || os.tmpdir());
  if (temporary.includes('!')) {
    throw new Error('Set LIBRETV_DESKTOP_BUILD_TEMP to a writable local directory without an exclamation mark.');
  }
  const scratch = fs.mkdtempSync(path.join(temporary, 'libretv-desktop-'));
  const source = path.join(scratch, 'source');
  const runtime = path.join(scratch, 'runtime');
  const desktop = path.join(scratch, 'app');
  const output = path.join(scratch, 'dist');
  for (const dir of [source, runtime, desktop]) fs.mkdirSync(dir);
  console.log('Build workspace:', root);
  console.log('Windows temporary staging:', scratch);

  for (const file of sourceInputs) copyInput(path.join(repo, file), path.join(source, file));
  for (const file of moduleInputs) copyInput(path.join(source, file), path.join(runtime, file));
  for (const file of mainInputs) copyInput(path.join(__dirname, file), path.join(desktop, file));
  copyInput(path.join(repo, 'LICENSE'), path.join(runtime, 'LICENSE'));

  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['DOCKER_BUILD', 'NODE_ENV', 'PASSWORD', 'PROXY_SECRET', 'DEFAULT_SOURCES',
    'DEFAULT_LIVE_SOURCES', 'DEFAULT_SUBSCRIPTIONS', 'FALLBACK_CORS_PROXY']) delete env[key];
  const ci = ['ci', '--no-audit', '--no-fund'];
  if (offline) ci.push('--offline');
  runNpm(source, [...ci, '--include=dev'], env);
  writeRuntimeConfig(source, runtime);
  runNpm(source, ['run', 'build'], env);
  runNpm(runtime, [...ci, '--omit=dev'], env);

  copyInput(path.join(source, 'public'), path.join(runtime, 'public'));
  fs.cpSync(path.join(source, '.next'), path.join(runtime, '.next'), {
    recursive: true,
    filter: (file) => {
      const entry = path.relative(path.join(source, '.next'), file).split(path.sep)[0];
      return !['cache', 'diagnostics', 'types', 'trace', 'trace-build', 'turbopack'].includes(entry);
    },
  });
  const pkg = json(path.join(runtime, 'package.json'));
  const manifest = {
    commit: gitHead(),
    version: pkg.version,
    buildId: fs.readFileSync(path.join(runtime, '.next', 'BUILD_ID'), 'utf8').trim(),
    platform: process.platform,
    arch: process.arch,
    buildNode: process.version,
    npm: json(path.join(path.dirname(process.env.npm_execpath), '..', 'package.json')).version,
    next: pkg.dependencies.next,
    electron: electronVersion,
    builder: tools.devDependencies['electron-builder'],
    packageSha256: sha256(path.join(runtime, 'package.json')),
    applicationLockSha256: sha256(path.join(runtime, 'package-lock.json')),
    desktopLockSha256: sha256(path.join(__dirname, 'package-lock.json')),
    inputSha256: Object.fromEntries(mainInputs.map((name) => [name, sha256(path.join(desktop, name))])),
  };
  saveJson(path.join(runtime, 'desktop-build.json'), manifest);
  verifyRuntime(runtime);

  saveJson(path.join(desktop, 'package.json'), {
    name: 'libretv-desktop', version: pkg.version, description: 'LibreTV Desktop',
    main: 'main.cjs', private: true, license: pkg.license,
  });
  let packaged;
  await build({
    projectDir: __dirname,
    targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64),
    publish: 'never',
    config: {
      appId: 'org.libretv.desktop',
      productName: 'LibreTV Desktop',
      electronVersion,
      electronDist,
      directories: { app: desktop, output },
      asar: true,
      npmRebuild: false,
      win: { signAndEditExecutable: false },
      afterPack(context) {
        packaged = context.appOutDir;
        const resources = path.join(packaged, 'resources');
        const packagedRuntime = path.join(resources, 'libretv-runtime');
        // Copy the prepared tree once, including .next and the locked native dependencies.
        copyInput(runtime, packagedRuntime);
        verifyRuntime(packagedRuntime);
        if (!fs.statSync(path.join(resources, 'app.asar')).isFile() ||
            peMachine(path.join(packaged, executableName)) !== 0x8664) {
          throw new Error('Packaged application failed verification');
        }
      },
    },
  });

  const delivery = path.join(root, 'dist', 'win-unpacked');
  copyInput(packaged, delivery);
  verifyRuntime(path.join(delivery, 'resources', 'libretv-runtime'));
  const exe = path.join(delivery, executableName);
  const result = {
    ...manifest,
    exe, executableBytes: fs.statSync(exe).size, executableSha256: sha256(exe),
    appAsarSha256: sha256(path.join(delivery, 'resources', 'app.asar')),
  };
  saveJson(path.join(root, 'resource-manifest.json'), result);
  console.log('Verified Windows x64 application:', exe);
  console.log('EXE SHA-256:', result.executableSha256);
}

packageDesktop().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
