const textSendQueues = new Map<string, Promise<void>>();

export function buildWecomTextSendQueueKey(accountId: string, recipientId: string): string {
  return `${accountId}:${recipientId}`;
}

export function enqueueWecomTextSendTask<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = textSendQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const queued = run.then(() => undefined, () => undefined);
  textSendQueues.set(key, queued);
  void queued.finally(() => {
    if (textSendQueues.get(key) === queued) {
      textSendQueues.delete(key);
    }
  });
  return run;
}

export function clearWecomTextSendQueues(): void {
  textSendQueues.clear();
}
