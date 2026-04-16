import 'dotenv/config';
import { readFile } from 'fs/promises';
import path from 'path';
import { closePool } from '../lib/db';
import { normalizeProjectManifest, upsertProjectManifest } from '../services/project-service';

function resolveManifestPath(): string {
  const flagIndex = process.argv.findIndex((value) => value === '--manifest');
  if (flagIndex === -1 || !process.argv[flagIndex + 1]) {
    throw new Error('Usage: npm run project:register -- --manifest manifests/example-project.json');
  }

  return path.resolve(process.cwd(), process.argv[flagIndex + 1]);
}

async function main(): Promise<void> {
  const manifestPath = resolveManifestPath();
  const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifest = normalizeProjectManifest(rawManifest);
  const project = await upsertProjectManifest(manifest);
  console.log(`Registered project ${project.projectKey} with ${project.features.length} features`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });