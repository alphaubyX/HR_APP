'use strict';

/**
 * Build the upload package for shared hosting (cPanel / CloudLinux):
 *   npm run build   →   release/   and   release.tar.gz
 *
 * The whole server, with Express and the MySQL driver, is bundled into ONE file
 * (release/server/index.js), so the web server needs no `npm install` and no node_modules.
 * Upload the contents of release/ (or extract release.tar.gz) into the app folder.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'release');
const pkg = require('../package.json');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'server'), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'server', 'index.js')],
  outfile: path.join(OUT, 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minifySyntax: true,
  legalComments: 'eof',
  logLevel: 'warning',
  banner: { js: `// Broadwing HR ${pkg.version}: built file, do not edit. Source: https://github.com/alphaubyX/HR_APP` },
});

fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(OUT, '.env.example'));

// No dependencies: there is nothing for cPanel's "Run NPM Install" to do.
fs.writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description, private: true,
  main: 'server/index.js', scripts: { start: 'node server/index.js' }, engines: { node: '>=20' }, license: pkg.license,
}, null, 2)}\n`);
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
fs.writeFileSync(path.join(OUT, 'UPLOAD-README.txt'), [
  `Broadwing HR ${pkg.version} - upload package`,
  '',
  'Extract everything into your app folder (e.g. /home/USER/broadwing-hr) so that package.json',
  'sits directly inside it. In cPanel > Setup Node.js App use:',
  '  Application root:  broadwing-hr',
  '  Startup file:      server/index.js',
  'No "Run NPM Install" is needed: everything the server needs is in server/index.js.',
  'Do NOT make the domain\'s document root the same folder as the app.',
  '',
  'Required environment variables: HR_DB_CLIENT=mysql, HR_DB_HOST, HR_DB_NAME, HR_DB_USER,',
  'HR_DB_PASSWORD, HR_DATA_DIR, HR_OWNER_USERNAME, HR_OWNER_PASSWORD, HR_OWNER_NAME, TRUST_PROXY=1.',
  'Check https://YOUR-HR-ADDRESS/api/health after starting: it says what is wrong if anything is.',
  '',
].join('\n'));

const tarFile = path.join(ROOT, 'release.tar.gz');
fs.rmSync(tarFile, { force: true });
execFileSync('tar', ['-czf', tarFile, '-C', OUT, '.']);
const size = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
console.log(`release/ ready (server bundle ${size(path.join(OUT, 'server', 'index.js'))}); release.tar.gz ${size(tarFile)}`);
