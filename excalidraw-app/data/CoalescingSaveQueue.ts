type Job<Input, Result> = {
  input: Input;
  promise: Promise<Result>;
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
};

type QueueState<Input, Result> = {
  active: { scope: string; job: Job<Input, Result> } | null;
  pending: Map<string, Job<Input, Result>>;
};

/**
 * Run at most one operation per key. Requests for the same scope retain only
 * their latest full snapshot, and all overlapping callers receive its result.
 * Separate scopes never replace one another (for example, a final room save
 * while switching rooms). A failed operation cannot poison subsequent saves.
 */
export class CoalescingSaveQueue<Key extends object, Input, Result> {
  private queues = new WeakMap<Key, QueueState<Input, Result>>();

  constructor(private run: (input: Input) => Promise<Result>) {}

  isBusy(key: Key, scope: string) {
    const state = this.queues.get(key);
    return state?.active?.scope === scope || !!state?.pending.has(scope);
  }

  enqueue(key: Key, scope: string, input: Input): Promise<Result> {
    let state = this.queues.get(key);
    if (!state) {
      state = { active: null, pending: new Map() };
      this.queues.set(key, state);
    }

    let job =
      state.pending.get(scope) ??
      (state.active?.scope === scope ? state.active.job : undefined);
    if (!job) {
      let resolve!: Job<Input, Result>["resolve"];
      let reject!: Job<Input, Result>["reject"];
      const promise = new Promise<Result>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      job = { input, promise, resolve, reject };
    }
    job.input = input;
    state.pending.set(scope, job);
    if (!state.active) {
      void this.drain(key, state);
    }
    return job.promise;
  }

  private async drain(key: Key, state: QueueState<Input, Result>) {
    while (state.pending.size) {
      const [scope, job] = state.pending.entries().next().value!;
      state.pending.delete(scope);
      state.active = { scope, job };
      try {
        const result = await this.run(job.input);
        // A newer snapshot was enqueued during this operation. Keep its
        // callers waiting until that snapshot is persisted too.
        if (!state.pending.has(scope)) {
          job.resolve(result);
        }
      } catch (error) {
        // The pending snapshot is a full replacement, so it can recover a
        // failed earlier operation without dropping the user's latest edits.
        if (!state.pending.has(scope)) {
          job.reject(error);
        }
      }
      state.active = null;
    }
    this.queues.delete(key);
  }
}
