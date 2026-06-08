import { executeCommandWithValidation } from "../../lib/command-execution/executor";

const repo = process.cwd();
const allowedPaths = [repo];
const agentCount = Number(process.env.AGENT_COUNT || 10);
const watchdogMs = Number(process.env.WATCHDOG_MS || 15_000);
const cases = (process.env.CASES || "clean,stdout_stderr,pipe_pressure,timeout").split(",").map((value) => value.trim()).filter(Boolean);

type CaseResult = {
  label: string;
  index: number;
  settled: boolean;
  elapsedMs?: number;
  success?: boolean;
  exitCode?: number | null;
  error?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  progressEvents: Array<{ t: number; status?: string; stdoutBytes: number; stderrBytes: number; chunkStream?: string }>;
};

function bashWrap(command: string): { command: string; args: string[] } {
  const wrapped = `${command}\n__selene_exit=$?\nprintf '\n__SELENE_CWD__:%s\n' "$(pwd -P)"\nexit $__selene_exit`;
  return { command: "/bin/sh", args: ["-lc", wrapped] };
}

async function runOne(label: string, index: number, mode: "direct" | "bash", command: string, args: string[], timeout = 5_000, maxOutputSize?: number): Promise<CaseResult> {
  const started = Date.now();
  const progressEvents: CaseResult["progressEvents"] = [];
  const final = mode === "bash" ? bashWrap([command, ...args.map((arg) => JSON.stringify(arg))].join(" ")) : { command, args };

  const result = await executeCommandWithValidation({
    command: final.command,
    args: final.args,
    cwd: repo,
    timeout,
    maxOutputSize,
    characterId: `${label}-agent-${index}`,
    toolCallId: `${label}-call-${index}`,
    onProgress: (update) => {
      progressEvents.push({
        t: Date.now() - started,
        status: update.status,
        stdoutBytes: update.stdout?.length ?? 0,
        stderrBytes: update.stderr?.length ?? 0,
        chunkStream: update.chunkStream,
      });
    },
  }, allowedPaths);

  return {
    label,
    index,
    settled: true,
    elapsedMs: Date.now() - started,
    success: result.success,
    exitCode: result.exitCode,
    error: result.error,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
    progressEvents,
  };
}

async function runCase(label: string, mode: "direct" | "bash", payload: { command: string; args: string[]; timeout?: number; maxOutputSize?: number }) {
  const pending = new Map<number, { started: number; last: string }>();
  const tasks = Array.from({ length: agentCount }, (_, index) => {
    pending.set(index, { started: Date.now(), last: "started" });
    return runOne(label, index, mode, payload.command, payload.args, payload.timeout, payload.maxOutputSize)
      .then((result) => {
        pending.delete(index);
        return result;
      })
      .catch((error) => {
        pending.delete(index);
        return {
          label,
          index,
          settled: true,
          elapsedMs: Date.now(),
          error: error instanceof Error ? error.message : String(error),
          progressEvents: [],
        } satisfies CaseResult;
      });
  });

  const watchdog = new Promise<"watchdog">((resolve) => setTimeout(() => resolve("watchdog"), watchdogMs));
  const all = Promise.all(tasks);
  const winner = await Promise.race([all, watchdog]);

  if (winner === "watchdog") {
    console.error(JSON.stringify({ label, mode, watchdogMs, pending: Array.from(pending.entries()).map(([index, state]) => ({ index, ageMs: Date.now() - state.started, last: state.last })) }, null, 2));
    process.exitCode = 2;
    return;
  }

  const results = winner as CaseResult[];
  const failures = results.filter((r) => !r.success);
  const slowest = [...results].sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0))[0];
  console.log(JSON.stringify({
    label,
    mode,
    agentCount,
    failures: failures.length,
    slowest: slowest && { index: slowest.index, elapsedMs: slowest.elapsedMs, stdoutBytes: slowest.stdoutBytes, stderrBytes: slowest.stderrBytes, error: slowest.error },
    results: results.map((r) => ({ index: r.index, elapsedMs: r.elapsedMs, success: r.success, exitCode: r.exitCode, error: r.error, stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, progressCount: r.progressEvents.length })),
  }, null, 2));
}

async function main() {
  if (cases.includes("clean")) {
    await runCase("clean", "direct", { command: "node", args: ["-e", "console.log('ok:' + process.pid)"] });
    await runCase("clean", "bash", { command: "node", args: ["-e", "console.log('ok:' + process.pid)"] });
  }
  if (cases.includes("stdout_stderr")) {
    await runCase("stdout_stderr", "direct", { command: "node", args: ["-e", "process.stderr.write('err:' + process.pid + '\\n'); console.log('out:' + process.pid)"] });
    await runCase("stdout_stderr", "bash", { command: "node", args: ["-e", "process.stderr.write('err:' + process.pid + '\\n'); console.log('out:' + process.pid)"] });
  }
  if (cases.includes("pipe_pressure")) {
    await runCase("pipe_pressure", "direct", { command: "node", args: ["-e", "for (let i=0;i<200;i++){process.stdout.write('x'.repeat(1024)+'\\n');process.stderr.write('e'.repeat(128)+'\\n')} console.log('done')"], timeout: 10_000 });
    await runCase("pipe_pressure", "bash", { command: "node", args: ["-e", "for (let i=0;i<200;i++){process.stdout.write('x'.repeat(1024)+'\\n');process.stderr.write('e'.repeat(128)+'\\n')} console.log('done')"], timeout: 10_000 });
  }
  if (cases.includes("timeout")) {
    await runCase("timeout", "direct", { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], timeout: 300 });
    await runCase("timeout", "bash", { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], timeout: 300 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
