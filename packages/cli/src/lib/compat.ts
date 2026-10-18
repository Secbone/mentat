// Explicit filesystem convenience entrypoints, kept out of assistant orchestration.
import {
  taskContext as context,
  type ReflectedCandidate,
  type RememberInput,
  rememberUserFact as remember,
  saveReflections as save,
} from "@mentat/assistant";
import { createMemoryAccess } from "@mentat/memory";
import { FileMemoryRepository, JsonFileMemoryStore } from "@mentat/memory-file";
import { ExperienceStore } from "@mentat/observability";
export function taskContext(path: string, task: string) {
  return context(new JsonFileMemoryStore(path), task);
}
export function rememberUserFact(
  path: string,
  dir: string,
  text: RememberInput,
  cwd = process.cwd(),
) {
  return remember(
    createMemoryAccess(new FileMemoryRepository(path)),
    new ExperienceStore(dir),
    text,
    cwd,
  );
}
export function saveReflections(path: string, candidates: ReflectedCandidate[]) {
  return save(createMemoryAccess(new FileMemoryRepository(path)), candidates);
}
