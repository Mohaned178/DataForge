import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// The repository's .env (see .env.example) is optional; variables already set in the environment win.
const repositoryEnv = resolve(__dirname, '..', '..', '.env');
if (existsSync(repositoryEnv)) {
  process.loadEnvFile(repositoryEnv);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] ?? 'postgresql://dataforge:dataforge@localhost:5433/dataforge' },
});
