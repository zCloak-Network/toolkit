// Copyright 2021-2023 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

import compareFunc from 'compare-func';
import fs from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const mainTemplate = fs.readFileSync(resolve(__dirname, './templates/template.hbs'), 'utf-8');
const headerPartial = fs.readFileSync(resolve(__dirname, './templates/header.hbs'), 'utf-8');
const commitPartial = fs.readFileSync(resolve(__dirname, './templates/commit.hbs'), 'utf-8');
const footerPartial = fs.readFileSync(resolve(__dirname, './templates/footer.hbs'), 'utf-8');

export default {
  mainTemplate,
  headerPartial,
  commitPartial,
  footerPartial,
  transform: (commit, context) => {
    const issues = [];

    commit.notes = commit.notes.filter((note) => note.title !== 'release-as');

    if (commit.type === 'feat') {
      commit.type = 'Features';
    } else if (commit.type === 'fix') {
      commit.type = 'Bug Fixes';
    } else if (commit.type === 'perf') {
      commit.type = 'Performance Improvements';
    } else if (commit.type === 'revert' || commit.revert) {
      commit.type = 'Reverts';
    } else {
      return;
    }

    if (commit.scope === '*') {
      commit.scope = '';
    }

    if (typeof commit.hash === 'string') {
      commit.shortHash = commit.hash.substring(0, 7);
    }

    if (typeof commit.subject === 'string') {
      let url = context.repository ? `${context.host}/${context.owner}/${context.repository}` : context.repoUrl;

      if (url) {
        url = `${url}/issues/`;
        // Issue URLs.
        commit.subject = commit.subject.replace(/#([0-9]+)/g, (_, issue) => {
          issues.push(issue);

          return `[#${issue}](${url}${issue})`;
        });
      }

      if (context.host) {
        // User URLs.
        commit.subject = commit.subject.replace(/\B@([a-z0-9](?:-?[a-z0-9/]){0,38})/g, (_, username) => {
          if (username.includes('/')) {
            return `@${username}`;
          }

          return `[@${username}](${context.host}/${username})`;
        });
      }
    }

    // remove references that already appear in the subject
    commit.references = commit.references.filter((reference) => {
      if (issues.indexOf(reference.issue) === -1) {
        return true;
      }

      return false;
    });

    return commit;
  },
  groupBy: 'type',
  commitGroupsSort: 'title',
  commitsSort: ['scope', 'subject'],
  noteGroupsSort: 'title',
  notesSort: compareFunc
};
