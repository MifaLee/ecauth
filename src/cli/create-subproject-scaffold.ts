import 'dotenv/config';
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

interface ScaffoldVariables {
  PROJECT_NAME: string;
  PROJECT_KEY: string;
  AUTH_PLATFORM_BASE_URL: string;
  SUBPROJECT_PORT: string;
  SUBPROJECT_CALLBACK_URL: string;
}

function readArg(flag: string): string | undefined {
  const index = process.argv.findIndex((value) => value === flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(flag: string): string {
  const value = readArg(flag);
  if (!value) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}

function replaceTemplate(content: string, variables: ScaffoldVariables): string {
  return Object.entries(variables).reduce((acc, [key, value]) => {
    return acc.replaceAll(`__${key}__`, value);
  }, content);
}

async function copyTemplateDir(sourceDir: string, targetDir: string, variables: ScaffoldVariables): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir);

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry);
    const renderedName = replaceTemplate(entry, variables);
    const targetPath = path.join(targetDir, renderedName);
    const sourceStat = await stat(sourcePath);
    if (sourceStat.isDirectory()) {
      await copyTemplateDir(sourcePath, targetPath, variables);
      continue;
    }

    const raw = await readFile(sourcePath, 'utf8');
    await writeFile(targetPath, replaceTemplate(raw, variables), 'utf8');
  }
}

async function main(): Promise<void> {
  const projectName = requiredArg('--name');
  const projectKey = requiredArg('--project-key');
  const outputDir = path.resolve(process.cwd(), requiredArg('--out-dir'));
  const authPlatformBaseUrl = readArg('--auth-base-url') || 'http://localhost:3008/ecauth';
  const port = readArg('--port') || '3010';
  const callbackUrl = readArg('--callback-url') || `http://localhost:${port}/auth/callback`;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const templateDir = path.join(__dirname, '..', '..', 'templates', 'subproject-express');
  const variables: ScaffoldVariables = {
    PROJECT_NAME: projectName,
    PROJECT_KEY: projectKey,
    AUTH_PLATFORM_BASE_URL: authPlatformBaseUrl,
    SUBPROJECT_PORT: port,
    SUBPROJECT_CALLBACK_URL: callbackUrl,
  };

  await copyTemplateDir(templateDir, outputDir, variables);
  console.log(`Subproject scaffold created at ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});