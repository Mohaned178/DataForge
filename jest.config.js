/**
 * pnpm test runs Jest with --experimental-vm-modules: NestJS 12 is ESM-only and the Prisma 7 client
 * loads its query compiler with a dynamic import, which Jest supports only with that flag (ADR-0011).
 * @type {import('jest').Config}
 */
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
    '^@dataforge/validation$': '<rootDir>/packages/validation/src/index.ts',
    '^@dataforge/targets$': '<rootDir>/packages/targets/src/index.ts',
    '^@dataforge/kafka$': '<rootDir>/packages/kafka/src/index.ts',
    '^@dataforge/execution$': '<rootDir>/packages/execution/src/index.ts',
  },
};
