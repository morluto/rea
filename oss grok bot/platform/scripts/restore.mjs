import { inspectBackup, restoreToNewRoot } from '../packages/host/src/backups.mjs';
const [command, backup, destination] = process.argv.slice(2);
if (command === 'inspect' && backup) console.log(JSON.stringify(inspectBackup(backup), null, 2));
else if (command === 'restore' && backup && destination)
  console.log(JSON.stringify(restoreToNewRoot(backup, destination), null, 2));
else {
  console.error('Usage: node scripts/restore.mjs inspect BACKUP | restore BACKUP NEW_DATA_ROOT');
  process.exitCode = 2;
}
