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
  roots: [
    '<rootDir>/libraries/ysocial',
    '<rootDir>/apps/backend/src/ysocial',
    '<rootDir>/apps/orchestrator/src/ysocial',
  ],
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts'],
  // ts-jest type-checks every file. With one worker per core a worker was
  // too slow to exit after the run and got killed. Half the cores is enough.
  maxWorkers: '50%',
  // ysocial code may import Postiz services by their aliases from
  // tsconfig.base.json. Our own library is imported with relative paths.
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$':
      '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/orchestrator/(.*)$': '<rootDir>/apps/orchestrator/src/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: path.join(root, 'apps/backend/tsconfig.json') },
    ],
  },
};
