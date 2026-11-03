import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` diffs src/schema.ts against drizzle/meta and writes a new
// SQL migration. Migrations are embedded in the app bundle (see src/migrations.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
