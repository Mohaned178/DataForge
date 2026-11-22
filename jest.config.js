/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/packages', '<rootDir>/apps'],
  testMatch: ['**/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '^@dataforge/core$': '<rootDir>/packages/core/src/index.ts',
    '^@dataforge/chaos$': '<rootDir>/packages/chaos/src/index.ts',
  },
};
