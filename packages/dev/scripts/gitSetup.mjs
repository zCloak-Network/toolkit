// Copyright 2021-2023 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from './execute.mjs';

const USER = 'github-actions[bot]';
const MAIL = 'github-actions[bot]@users.noreply.github.com';

export default function gitSetup() {
  execSync(`git config user.name "${USER}"`);
  execSync(`git config user.email "${MAIL}"`);

  execSync('git config push.default simple');
  execSync('git config merge.ours.driver true');
}
