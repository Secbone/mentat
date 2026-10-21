export function acquireFileLock(path: string): () => void;
export function withFileLock<T>(path: string, fn: () => T, timeoutMs?: number): T;
