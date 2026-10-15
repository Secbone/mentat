import { JsonFileMemoryStore, JsonlMemoryAudit, migrateLegacyMemory } from "@mentat/memory-file";
import { defaultMemoryPath } from "../lib/paths";

export async function memoryCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "migrate") {
    process.stderr.write(
      "usage: mentat memory migrate [--memory <file>] [--snapshot <file>] [--audit <file>]\n",
    );
    return 1;
  }

  let memoryPath = defaultMemoryPath(process.cwd());
  let snapshotPath: string | undefined;
  let auditPath: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--memory") memoryPath = args[++i] ?? memoryPath;
    else if (arg === "--snapshot") snapshotPath = args[++i];
    else if (arg === "--audit") auditPath = args[++i];
  }
  snapshotPath ??= `${memoryPath}.pre-migration.json`;
  auditPath ??= `${memoryPath}.audit.jsonl`;

  const store = new JsonFileMemoryStore(memoryPath);
  const report = migrateLegacyMemory(store, {
    snapshotPath,
    audit: new JsonlMemoryAudit(auditPath),
  });
  process.stdout.write(
    `migrated ${report.migrated}/${report.total} legacy entries (unconfirmed, source unknown)\n`,
  );
  if (report.snapshotPath) process.stdout.write(`snapshot: ${report.snapshotPath}\n`);
  return 0;
}
