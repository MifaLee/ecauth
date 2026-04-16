import 'dotenv/config';
import { closePool } from '../lib/db';
import { syncEcOrganization } from '../services/ec-org-service';

function readArg(flag: string): string | undefined {
  const index = process.argv.findIndex((value) => value === flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const actorUserId = readArg('--actor-user-id');
  const summary = await syncEcOrganization(actorUserId);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });