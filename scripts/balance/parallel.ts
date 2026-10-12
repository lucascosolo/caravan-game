/**
 * Fan a list of pure tasks out over child processes (the sweep is CPU-bound and every fight is
 * independent). Each child is this same process image (`fork` with the parent's execArgv, so the
 * tsx loader comes along), gets its share of task indices over IPC, runs `worker(task)` for each
 * and sends the results back. The parent reassembles them IN TASK ORDER, so the output is the
 * same whatever the job count or scheduling — the sweep stays deterministic.
 *
 * Usage (in a script): `await runParallel(tasks, worker, jobs)`, and call `serveIfChild(worker)`
 * at the top level of the same module so a forked child serves instead of running the script.
 */
import { fork } from "node:child_process";
import { availableParallelism } from "node:os";

const CHILD_FLAG = "CARAVAN_BALANCE_CHILD";

export function isChild(): boolean {
  return process.env[CHILD_FLAG] === "1";
}

/** In a forked child: answer each batch of tasks, then exit when the parent disconnects. Returns true when this process is a child. */
export function serveIfChild<T, R>(worker: (task: T) => R): boolean {
  if (!isChild()) return false;
  process.on("message", (msg: { tasks: { i: number; task: T }[] }) => {
    const out = msg.tasks.map(({ i, task }) => ({ i, result: worker(task) }));
    process.send!({ out });
  });
  process.on("disconnect", () => process.exit(0));
  return true;
}

export function defaultJobs(): number {
  return Math.max(1, availableParallelism());
}

export async function runParallel<T, R>(script: string, tasks: readonly T[], worker: (task: T) => R, jobs = defaultJobs(), onProgress?: (done: number, total: number) => void): Promise<R[]> {
  if (jobs <= 1 || tasks.length <= 1) {
    const out: R[] = [];
    tasks.forEach((t, i) => {
      out.push(worker(t));
      onProgress?.(i + 1, tasks.length);
    });
    return out;
  }
  const results: R[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  const batch = Math.max(1, Math.min(8, Math.ceil(tasks.length / (jobs * 8))));
  await Promise.all(
    Array.from({ length: Math.min(jobs, tasks.length) }, () =>
      new Promise<void>((resolveChild, reject) => {
        const child = fork(script, process.argv.slice(2), { execArgv: process.execArgv, env: { ...process.env, [CHILD_FLAG]: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
        const send = () => {
          if (next >= tasks.length) {
            child.disconnect();
            return;
          }
          const slice: { i: number; task: T }[] = [];
          while (slice.length < batch && next < tasks.length) slice.push({ i: next, task: tasks[next++]! });
          child.send({ tasks: slice });
        };
        child.on("message", (msg: { out: { i: number; result: R }[] }) => {
          for (const { i, result } of msg.out) results[i] = result;
          done += msg.out.length;
          onProgress?.(done, tasks.length);
          send();
        });
        child.on("exit", (code) => (code === 0 ? resolveChild() : reject(new Error(`balance worker exited with ${String(code)}`))));
        child.on("error", reject);
        send();
      }),
    ),
  );
  return results;
}
