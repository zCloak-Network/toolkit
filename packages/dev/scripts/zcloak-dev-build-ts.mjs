#!/usr/bin/env node
// Copyright 2021-2022 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

import babel from '@babel/cli/lib/babel/dir.js';
import fs from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';
import rimraf from 'rimraf';

import { copySync } from './copy.mjs';
import { __dirname } from './dirname.mjs';
import { execSync } from './execute.mjs';

const BL_CONFIGS = ['js', 'cjs'].map((e) => `babel.config.${e}`);
const WP_CONFIGS = ['js', 'cjs'].map((e) => `webpack.config.${e}`);
const RL_CONFIGS = ['js', 'mjs', 'cjs'].map((e) => `rollup.config.${e}`);
const CPX = ['patch', 'js', 'cjs', 'mjs', 'json', 'd.ts', 'css', 'gif', 'hbs', 'jpg', 'png', 'svg']
  .map((e) => `src/**/*.${e}`)
  .concat(['package.json', 'README.md', 'LICENSE']);

console.log('$ zcloak-dev-build-ts', process.argv.slice(2).join(' '));

const IGNORE_IMPORTS = [
  // node
  'crypto',
  'fs',
  'path',
  'process',
  'readline',
  'util',
  // other
  '@jest/globals',
  'react',
  'react-native'
];

// webpack build
function buildWebpack() {
  const config = WP_CONFIGS.find((c) => fs.existsSync(path.join(process.cwd(), c)));

  execSync(`yarn zcloak-exec-webpack --config ${config} --mode production`);
}

// compile via babel, either via supplied config or default
async function buildBabel(dir, type) {
  const configs = BL_CONFIGS.map((c) => path.join(process.cwd(), `../../${c}`));
  const outDir = path.join(process.cwd(), `build${type === 'esm' ? '' : '-cjs'}`);

  await babel.default({
    babelOptions: {
      configFile:
        type === 'esm'
          ? path.join(__dirname, '../config/babel-config-esm.cjs')
          : configs.find((f) => fs.existsSync(f)) ||
            path.join(__dirname, '../config/babel-config-cjs.cjs')
    },
    cliOptions: {
      extensions: ['.ts', '.tsx'],
      filenames: ['src'],
      ignore: '**/*.d.ts',
      outDir,
      outFileExtension: '.js'
    }
  });

  // rewrite a skeleton package.json with a type=module
  if (type !== 'esm') {
    [
      ...CPX,
      `../../build/${dir}/src/**/*.d.ts`,
      `../../build/packages/${dir}/src/**/*.d.ts`
    ].forEach((s) => copySync(s, 'build'));
  }
}

function witeJson(path, json) {
  fs.writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function adjustJsPath(pkgCwd, pkgJson, dir, f, isDeclare) {
  if (f.startsWith('.')) {
    if (f.endsWith('.js') || f.endsWith('.json')) {
      // ignore, these are already fully-specified
      return null;
    }

    const dirPath = path.join(process.cwd(), dir, f);
    const jsFile = `${f}.js`;
    const jsPath = path.join(process.cwd(), dir, jsFile);

    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      // this is a directory, append index.js
      return `${f}/index.js`;
    } else if (fs.existsSync(jsPath)) {
      // local source file
      return jsFile;
    }
  }

  // do not adjust
  return null;
}

function rewriteEsmImports(pkgCwd, pkgJson, dir, replacer) {
  if (!fs.existsSync(dir)) {
    return;
  }

  fs.readdirSync(dir).forEach((p) => {
    const thisPath = path.join(process.cwd(), dir, p);

    if (fs.statSync(thisPath).isDirectory()) {
      rewriteEsmImports(pkgCwd, pkgJson, `${dir}/${p}`, replacer);
    } else if (
      thisPath.endsWith('.js') ||
      thisPath.endsWith('.ts') ||
      thisPath.endsWith('.tsx') ||
      thisPath.endsWith('.md')
    ) {
      fs.writeFileSync(
        thisPath,
        fs
          .readFileSync(thisPath, 'utf8')
          .split('\n')
          .map((line) =>
            line
              // handle import/export
              .replace(/(import|export) (.*) from '(.*)'/g, (o, t, a, f) => {
                const adjusted = replacer(pkgCwd, pkgJson, dir, f);

                return adjusted ? `${t} ${a} from '${adjusted}'` : o;
              })
              // handle augmented inputs
              .replace(/(import|declare module) '(.*)'/g, (o, t, f) => {
                const adjusted = replacer(pkgCwd, pkgJson, dir, f, t !== 'import');

                return adjusted ? `${t} '${adjusted}'` : o;
              })
              // handle dynamic imports
              .replace(/( import|^import)\('(.*)'\)/g, (o, t, f) => {
                const adjusted = replacer(pkgCwd, pkgJson, dir, f);

                return adjusted ? `${t}('${adjusted}')` : o;
              })
          )
          .join('\n')
      );
    }
  });
}

function relativePath(value) {
  return `${value.startsWith('.') ? value : './'}${value}`.replace(/\/\//g, '/');
}

// creates an entry for the cjs/esm name
function createMapEntry(rootDir, jsPath, noTypes) {
  jsPath = relativePath(jsPath);

  const otherPath = jsPath.replace('./', './cjs/');
  const hasOther = fs.existsSync(path.join(`${rootDir}-cjs`, jsPath));
  const typesPath = jsPath.replace('.js', '.d.ts');
  const hasTypes =
    !noTypes && jsPath.endsWith('.js') && fs.existsSync(path.join(rootDir, typesPath));
  const field = hasOther
    ? {
        ...(hasTypes ? { types: typesPath } : {}),
        require: otherPath,
        // eslint-disable-next-line sort-keys
        default: jsPath
      }
    : hasTypes
    ? {
        types: typesPath,
        // eslint-disable-next-line sort-keys
        default: jsPath
      }
    : jsPath;

  if (jsPath.endsWith('.js')) {
    if (jsPath.endsWith('/index.js')) {
      return [jsPath.replace('/index.js', ''), field];
    } else {
      return [jsPath.replace('.js', ''), field];
    }
  }

  return [jsPath, field];
}

// find the names of all the files in a certain directory
function findFiles(buildDir, extra = '', exclude = []) {
  const currDir = extra ? path.join(buildDir, extra) : buildDir;

  return fs.readdirSync(currDir).reduce((all, jsName) => {
    const jsPath = `${extra}/${jsName}`;
    const fullPathEsm = path.join(buildDir, jsPath);
    const toDelete =
      // no test paths
      jsPath.includes('/test/') ||
      // // no tests
      ['.manual.', '.spec.', '.test.'].some((t) => jsName.includes(t)) ||
      // no .d.ts compiled outputs
      ['.d.js', '.d.cjs', '.d.mjs'].some((e) => jsName.endsWith(e)) ||
      // .d.ts without .js as an output
      (jsName.endsWith('.d.ts') &&
        !fs.existsSync(path.join(buildDir, jsPath.replace('.d.ts', '.js'))));

    if (fs.statSync(fullPathEsm).isDirectory()) {
      findFiles(buildDir, jsPath).forEach((entry) => all.push(entry));
    } else if (toDelete) {
      const fullPathCjs = path.join(`${buildDir}-cjs`, jsPath);

      fs.unlinkSync(fullPathEsm);
      fs.existsSync(fullPathCjs) && fs.unlinkSync(fullPathCjs);
    } else {
      if (!exclude.some((e) => jsName === e)) {
        // this is not mapped to a compiled .js file (where we have dual esm/cjs mappings)
        all.push(createMapEntry(buildDir, jsPath));
      }
    }

    return all;
  }, []);
}

function tweakCjsPaths(buildDir) {
  const cjsDir = `${buildDir}-cjs`;

  fs.readdirSync(cjsDir)
    .filter((n) => n.endsWith('.js'))
    .forEach((jsName) => {
      const thisPath = path.join(cjsDir, jsName);

      fs.writeFileSync(
        thisPath,
        fs.readFileSync(thisPath, 'utf8').replace(
          // require("@zcloak/$1/$2")
          /require\("@zcloak\/([a-z-]*)\/(.*)"\)/g,
          'require("@zcloak/$1/cjs/$2")'
        )
      );
    });
}

function moveFields(pkg, fields) {
  fields.forEach((k) => {
    if (typeof pkg[k] !== 'undefined') {
      const value = pkg[k];

      delete pkg[k];

      pkg[k] = value;
    }
  });
}

// iterate through all the files that have been built, creating an exports map
function buildExports() {
  const buildDir = path.join(process.cwd(), 'build');

  mkdirp.sync(path.join(buildDir, 'cjs'));

  witeJson(path.join(buildDir, 'cjs/package.json'), { type: 'commonjs' });
  tweakCjsPaths(buildDir);

  const pkgPath = path.join(buildDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const listRoot = findFiles(buildDir, '', ['README.md', 'LICENSE']);

  if (!listRoot.some(([key]) => key === '.')) {
    const indexDef = relativePath(pkg.main).replace('.js', '.d.ts');

    // for the env-specifics, add a root key (if not available)
    listRoot.push([
      '.',
      {
        types: indexDef,
        // eslint-disable-next-line sort-keys
        'react-native': createMapEntry(buildDir, pkg['react-native'], true)[1],
        // eslint-disable-next-line sort-keys
        browser: createMapEntry(buildDir, pkg.browser, true)[1],
        node: createMapEntry(buildDir, pkg.main, true)[1]
      }
    ]);
  }

  // cleanup extraneous fields
  delete pkg.devDependencies;

  if (!pkg.main && fs.existsSync(path.join(buildDir, 'index.d.ts'))) {
    pkg.main = 'index.js';
  }

  if (pkg.main) {
    const main = pkg.main.startsWith('./') ? pkg.main : `./${pkg.main}`;

    pkg.main = main.replace(/^\.\//, './cjs/');
    pkg.module = main;
    pkg.types = main.replace('.js', '.d.ts');
  }

  // Ensure the top-level entries always points to the CJS version
  ['browser', 'react-native'].forEach((k) => {
    if (typeof pkg[k] === 'string') {
      const entry = pkg[k].startsWith('./') ? pkg[k] : `./${pkg[k]}`;

      pkg[k] = entry.replace(/^\.\//, './cjs/');
    }
  });

  if (Array.isArray(pkg.sideEffects)) {
    pkg.sideEffects = pkg.sideEffects.map((s) =>
      s.endsWith('.cjs') ? s.replace(/^\.\//, './cjs/').replace('.cjs', '.js') : s
    );
  }

  pkg.type = 'module';

  pkg.exports = listRoot
    .filter(
      ([path, config]) =>
        // we handle the CJS path at the root below
        path !== './cjs/package.json' &&
        (typeof config === 'object' ||
          !listRoot.some(
            ([, c]) => typeof c === 'object' && Object.values(c).some((v) => v === path)
          ))
    )
    .sort((a, b) => a[0].localeCompare(b[0]))
    .reduce((all, [path, config]) => {
      const entry =
        typeof config === 'string'
          ? config
          : Object.entries({
              ...((pkg.exports && pkg.exports[path]) || {}),
              ...config
            })
              .sort(([a], [b]) => (a === 'types' ? -1 : b === 'types' ? 1 : 0))
              .reduce(
                (all, [key, value]) => ({
                  ...all,
                  [key]: value
                }),
                {}
              );

      return {
        ...all,
        ...(path === '.'
          ? { './cjs/package.json': './cjs/package.json', './cjs/*': './cjs/*.js' }
          : {}),
        [path]: entry
      };
    }, {});

  moveFields(pkg, [
    'main',
    'module',
    'browser',
    'react-native',
    'types',
    'exports',
    'dependencies',
    'optionalDependencies',
    'peerDependencies'
  ]);
  witeJson(pkgPath, pkg);

  // copy from build-cjs to build/cjs
  ['./build-cjs/**/*.js'].forEach((s) => copySync(s, 'build/cjs'));
}

function sortJson(json) {
  return Object.entries(json)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce((all, [k, v]) => ({ ...all, [k]: v }), {});
}

function orderPackageJson(repoPath, dir, json) {
  json.bugs = `https://github.com/${repoPath}/issues`;
  json.homepage = `https://github.com/${repoPath}${
    dir ? `/tree/master/packages/${dir}` : ''
  }#readme`;
  json.license = !json.license || json.license === 'Apache-2' ? 'Apache-2.0' : json.license;
  json.repository = {
    ...(dir ? { directory: `packages/${dir}` } : {}),
    type: 'git',
    url: `https://github.com/${repoPath}.git`
  };
  json.sideEffects = json.sideEffects || false;

  // sort the object
  const sorted = sortJson(json);

  // remove empty artifacts
  ['engines'].forEach((d) => {
    if (typeof json[d] === 'object' && Object.keys(json[d]).length === 0) {
      delete sorted[d];
    }
  });

  // move the different entry points to the (almost) end
  ['browser', 'electron', 'main', 'module', 'react-native'].forEach((d) => {
    delete sorted[d];

    if (json[d]) {
      sorted[d] = json[d];
    }
  });

  // move bin, scripts & dependencies to the end
  [
    ['bin', 'scripts'],
    ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions']
  ].forEach((a) =>
    a.forEach((d) => {
      delete sorted[d];

      if (json[d] && Object.keys(json[d]).length) {
        sorted[d] = sortJson(json[d]);
      }
    })
  );

  witeJson(path.join(process.cwd(), 'package.json'), sorted);
}

function createError(full, line, lineNumber, error) {
  return `${full}:: ${
    lineNumber >= 0 ? `line ${lineNumber + 1}:: ` : ''
  }${error}:: \n\n\t${line}\n`;
}

function throwOnErrors(errors) {
  if (errors.length) {
    throw new Error(errors.join('\n'));
  }
}

function loopFiles(exts, dir, sub, fn, allowComments = false) {
  return fs.readdirSync(sub).reduce((errors, inner) => {
    const full = path.join(sub, inner);

    if (fs.statSync(full).isDirectory()) {
      return errors.concat(loopFiles(exts, dir, full, fn, allowComments));
    } else if (exts.some((e) => full.endsWith(e))) {
      return errors.concat(
        fs
          .readFileSync(full, 'utf-8')
          .split('\n')
          .map((l, n) => {
            const t = l
              // no leading/trailing whitespace
              .trim()
              // anything starting with * (multi-line comments)
              .replace(/^\*.*/, '')
              // anything between /* ... */
              .replace(/\/\*.*\*\//g, '')
              // single line comments with // ...
              .replace(allowComments ? /--------------------/ : /\/\/.*/, '');

            return fn(`${dir}/${full}`, t, n);
          })
          .filter((e) => !!e)
      );
    }

    return errors;
  }, []);
}

function lintOutput(dir) {
  throwOnErrors(
    loopFiles(['.d.ts', '.js', '.cjs'], dir, 'build', (full, l, n) => {
      if (l.startsWith('import ') && l.includes(" from '") && l.includes('/src/')) {
        // we are not allowed to import from /src/
        return createError(full, l, n, 'Invalid import from /src/');
        // eslint-disable-next-line no-useless-escape
      } else if (/[\+\-\*\/\=\<\>\|\&\%\^\(\)\{\}\[\] ][0-9]{1,}n/.test(l)) {
        // we don't want untamed BigInt literals
        return createError(full, l, n, 'Prefer BigInt(<digits>) to <digits>n');
      }

      return null;
    })
  );
}

function getReferences(config) {
  const configPath = path.join(process.cwd(), config);

  if (fs.existsSync(configPath)) {
    try {
      return [
        JSON.parse(fs.readFileSync(configPath, 'utf-8')).references.map(({ path }) =>
          path.replace('../', '').replace('/tsconfig.build.json', '')
        ),
        true
      ];
    } catch (error) {
      console.error(`Unable to parse ${configPath}`);

      throw error;
    }
  }

  return [[], false];
}

function lintDependencies(dir, locals) {
  const {
    dependencies = {},
    devDependencies = {},
    name,
    private: isPrivate,
    optionalDependencies = {},
    peerDependencies = {}
  } = JSON.parse(fs.readFileSync(path.join(process.cwd(), './package.json'), 'utf-8'));

  if (isPrivate) {
    return;
  }

  const deps = [
    ...Object.keys(dependencies),
    ...Object.keys(peerDependencies),
    ...Object.keys(optionalDependencies)
  ];
  const devDeps = [...Object.keys(devDependencies), ...deps];
  const [references] = getReferences('tsconfig.build.json');
  const [devRefs, hasDevConfig] = getReferences('tsconfig.spec.json');
  const refsFound = [];

  throwOnErrors(
    loopFiles(['.ts', '.tsx'], dir, 'src', (full, l, n) => {
      if (l.startsWith("import '") || (l.startsWith('import ') && l.includes(" from '"))) {
        const dep = l
          .split(l.includes(" from '") ? " from '" : " '")[1]
          .split("'")[0]
          .split('/')
          .slice(0, 2)
          .join('/');

        if (name !== dep && !dep.startsWith('.') && !IGNORE_IMPORTS.includes(dep)) {
          const local = locals.find(([, name]) => name === dep);
          const isTest =
            full.endsWith('.spec.ts') ||
            full.endsWith('.test.ts') ||
            full.endsWith('.manual.ts') ||
            full.includes('/test/');

          if (!(isTest ? devDeps : deps).includes(dep)) {
            return createError(full, l, n, `${dep} is not included in package.json dependencies`);
          } else if (local) {
            const ref = local[0];

            if (!(isTest && hasDevConfig ? devRefs : references).includes(ref)) {
              return createError(
                full,
                l,
                n,
                `../${ref} not included in ${
                  isTest && hasDevConfig ? 'tsconfig.spec.json' : 'tsconfig.build.json'
                } references`
              );
            }

            if (!refsFound.includes(ref)) {
              refsFound.push(ref);
            }
          }
        }

        return null;
      }
    })
  );

  const extraRefs = references.filter((r) => !refsFound.includes(r));

  if (extraRefs.length) {
    throwOnErrors([
      createError(
        `${dir}/tsconfig.build.json`,
        extraRefs.join(', '),
        -1,
        'Unused tsconfig.build.json references found'
      )
    ]);
  }
}

function timeIt(label, fn) {
  const start = Date.now();

  fn();

  console.log(`${label} (${Date.now() - start}ms)`);
}

async function buildJs(repoPath, dir, locals) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), './package.json'), 'utf-8'));
  const { name, version } = pkgJson;

  console.log(`*** ${name} ${version}`);

  orderPackageJson(repoPath, dir, pkgJson);

  if (!fs.existsSync(path.join(process.cwd(), '.skip-build'))) {
    const cjsRoot = path.join(process.cwd(), 'src/cjs');

    if (fs.existsSync(path.join(cjsRoot, 'dirname.d.ts'))) {
      rimraf.sync(cjsRoot);
    }

    if (fs.existsSync(path.join(process.cwd(), 'public'))) {
      buildWebpack();
    } else {
      await buildBabel(dir, 'cjs');
      await buildBabel(dir, 'esm');

      // adjust the import paths
      rewriteEsmImports(process.cwd(), pkgJson, 'build-swc-esm', adjustJsPath);

      timeIt('Successfully built exports', () => buildExports());
      timeIt('Successfully linted configs', () => {
        lintOutput(dir);
        lintDependencies(dir, locals);
      });
    }
  }

  console.log();
}

async function main() {
  execSync('yarn zcloak-dev-clean-build');

  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), './package.json'), 'utf-8'));

  if (pkg.scripts && pkg.scripts['build:extra']) {
    execSync('yarn build:extra');
  }

  const repoPath = pkg.repository.url.split('https://github.com/')[1].split('.git')[0];

  orderPackageJson(repoPath, null, pkg);
  execSync('yarn zcloak-exec-tsc --build tsconfig.build.json');

  process.chdir('packages');

  const dirs = fs
    .readdirSync('.')
    .filter(
      (dir) => fs.statSync(dir).isDirectory() && fs.existsSync(path.join(process.cwd(), dir, 'src'))
    );
  const locals = [];

  // get all package names
  for (const dir of dirs) {
    const { name } = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), dir, './package.json'), 'utf-8')
    );

    locals.push([dir, name]);
  }

  // build packages
  for (const dir of dirs) {
    process.chdir(dir);

    await buildJs(repoPath, dir, locals);

    process.chdir('..');
  }

  process.chdir('..');

  if (RL_CONFIGS.some((c) => fs.existsSync(path.join(process.cwd(), c)))) {
    execSync('yarn zcloak-exec-rollup --config');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(-1);
});
