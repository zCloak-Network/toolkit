#!/usr/bin/env node
// Copyright 2021-2023 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { getPackagesSync } from '@manypkg/get-packages';
import path from 'path';
import rimraf from 'rimraf';

const { packages, rootPackage } = getPackagesSync(process.cwd());

const DIRS = [
  'build',
  ...['cjs', 'esm'].map((d) => `build-${d}`),
  ...['tsbuildinfo', 'build.tsbuildinfo'].map((d) => `tsconfig.${d}`)
];

console.log('$ zcloak-dev-clean-build', process.argv.slice(2).join(' '));

function getPaths(dir) {
  return DIRS.map((p) => path.join(dir, p));
}

function cleanDirs(dirs) {
  dirs.forEach((d) => rimraf.sync(d));
}

cleanDirs(getPaths(rootPackage.dir));

packages.forEach((pkg) => {
  cleanDirs(getPaths(pkg.dir));
});
