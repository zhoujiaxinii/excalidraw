import { describe, expect, it, vi } from "vitest";

import { CoalescingSaveQueue } from "./CoalescingSaveQueue";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
describe("coalesced cloud saves", () => {
  it("serializes overlapping requests and persists the latest queued scene", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const run = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const queue = new CoalescingSaveQueue<object, number, number>(run);
    const key = {};
    const a = queue.enqueue(key, "room", 1);
    const b = queue.enqueue(key, "room", 2);
    const c = queue.enqueue(key, "room", 3);
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual([3]);
    expect(queue.isBusy(key, "room")).toBe(true);
    second.resolve(3);
    expect(await Promise.all([a, b, c])).toEqual([3, 3, 3]);
    expect(queue.isBusy(key, "room")).toBe(false);
  });
  it("drains latest edits after a failed earlier attempt", async () => {
    const pending = deferred<number>();
    const run = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(2);
    const queue = new CoalescingSaveQueue<object, number, number>(run);
    const key = {};
    const a = queue.enqueue(key, "room", 1);
    const b = queue.enqueue(key, "room", 2);
    pending.reject(new Error("503"));
    expect(await Promise.all([a, b])).toEqual([2, 2]);
  });
  it("allows retries after terminal errors", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(2);
    const queue = new CoalescingSaveQueue<object, number, number>(run);
    const key = {};
    await expect(queue.enqueue(key, "room", 1)).rejects.toThrow("503");
    expect(await queue.enqueue(key, "room", 2)).toBe(2);
  });
  it("never replaces pending work from another room", async () => {
    const pending = deferred<number>();
    const run = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (input: number) => input);
    const queue = new CoalescingSaveQueue<object, number, number>(run);
    const key = {};
    const a = queue.enqueue(key, "old", 1);
    const b = queue.enqueue(key, "new", 2);
    pending.resolve(1);
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(run.mock.calls).toEqual([[1], [2]]);
  });
});
