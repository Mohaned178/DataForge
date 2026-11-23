import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const nondeterministicProperties = [
  { object: 'Math', property: 'random', message: 'Use a RandomStream derived from the run seed.' },
  { object: 'Date', property: 'now', message: 'Business time comes from the simulation clock, not the machine clock.' },
  { object: 'performance', property: 'now', message: 'Wall-clock time is not allowed in the simulation core.' },
  { object: 'crypto', property: 'randomUUID', message: 'IDs must be derived deterministically.' },
  { object: 'crypto', property: 'getRandomValues', message: 'Use a RandomStream derived from the run seed.' },
  { property: 'localeCompare', message: 'Locale-sensitive ordering differs between machines. Use compareCodeUnits().' },
  { property: 'toLocaleString', message: 'Locale-sensitive formatting differs between machines.' },
];

const nondeterministicSyntax = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'new Date() reads the machine clock. Use the simulation clock.',
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message: 'Date() reads the machine clock. Use the simulation clock.',
  },
];

const coreForbiddenImports = {
  paths: [
    {
      name: 'node:crypto',
      importNames: ['randomBytes', 'randomUUID', 'randomInt', 'getRandomValues', 'webcrypto'],
      message: 'Only deterministic hashing is allowed in the simulation core.',
    },
  ],
  patterns: [
    {
      group: ['node:fs', 'node:fs/*', 'fs', 'node:net', 'node:http', 'node:https', 'node:child_process', 'node:worker_threads', 'node:os'],
      message: 'The simulation core performs no I/O. Do file and network work in apps/*.',
    },
    {
      group: ['@nestjs/*', '@prisma/*', 'prisma', 'kafkajs', 'react', 'react-dom'],
      message: 'The simulation core must stay framework- and infrastructure-independent.',
    },
  ],
};

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'out/**', 'apps/api/src/generated/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Plain JavaScript files are CommonJS configuration and setup files run by Node.
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly', URL: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The chaos planner, validator and reference targets must be as deterministic as the simulation:
    // same inputs, same plan, same actual state, same report.
    files: ['packages/core/src/**/*.ts', 'packages/chaos/src/**/*.ts', 'packages/validation/src/**/*.ts', 'packages/targets/src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...nondeterministicProperties],
      'no-restricted-syntax': ['error', ...nondeterministicSyntax],
      'no-restricted-imports': ['error', coreForbiddenImports],
    },
  },
  {
    // @dataforge/kafka is held to the same rules, except the two modules that talk to the broker. A new
    // file is guarded by default; the executor reads time only from the clock it is given.
    files: ['packages/kafka/src/**/*.ts'],
    ignores: ['packages/kafka/src/client.ts', 'packages/kafka/src/consumer-runner.ts'],
    rules: {
      'no-restricted-properties': ['error', ...nondeterministicProperties],
      'no-restricted-syntax': ['error', ...nondeterministicSyntax],
      'no-restricted-imports': ['error', coreForbiddenImports],
    },
  },
  {
    // @dataforge/execution: the step formats, planning, in-process delivery, validation and the
    // external-pipeline checks are pure too. Only the Kafka delivery and the consumer process do I/O.
    files: ['packages/execution/src/**/*.ts'],
    ignores: ['packages/execution/src/kafka-delivery.ts', 'packages/execution/src/consumer-process.ts'],
    rules: {
      'no-restricted-properties': ['error', ...nondeterministicProperties],
      'no-restricted-syntax': ['error', ...nondeterministicSyntax],
      'no-restricted-imports': ['error', coreForbiddenImports],
    },
  },
);
