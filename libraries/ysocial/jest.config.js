// Minimal Jest setup for the ysocial folders.
// The root jest.config.ts needs @nx/jest, which Postiz does not install, so
// `pnpm test` cannot run upstream. This config only covers our own code and
// reuses jest and ts-jest from the root devDependencies.
//
// Run from the repo root:
//   pnpm exec jest -c libraries/ysocial/jest.config.js
const path = require('path');

const root = path.join(__dirname, '..', '..');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: root,
  roots: ['<rootDir>/libraries/ysocial', '<rootDir>/apps/backend/src/ysocial'],
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: path.join(root, 'apps/backend/tsconfig.json') },
    ],
  },
};
