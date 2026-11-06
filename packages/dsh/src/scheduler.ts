export interface TimerScheduler {
  set(action: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

export const defaultTimerScheduler: TimerScheduler = {
  set: (action, intervalMs) => setInterval(action, intervalMs),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
