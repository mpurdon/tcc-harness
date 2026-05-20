import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGitRoot, userConfigDir } from "./config.ts";

export type AuthEvent = "login_success" | "login_fail" | "expired_detected";

/** Append a single AWS SSO event to ~/.tcc/auth-log.jsonl. Best-effort —
 *  never throws (we don't want auth telemetry to break a session). */
export function logAuthEvent(event: AuthEvent, profile: string, source: string): void {
	try {
		mkdirSync(userConfigDir(), { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), event, profile, source });
		appendFileSync(join(userConfigDir(), "auth-log.jsonl"), `${line}\n`);
	} catch {
		// swallow — auth logging is observability, not load-bearing
	}
}

/** USD formatter shared across usage / budget displays. */
export function fmtDollars(d: number): string {
	if (d === 0) return "$0.00";
	if (d < 0.01) return `$${d.toFixed(4)}`;
	return `$${d.toFixed(2)}`;
}

/** Read + parse a JSON file. Returns undefined on ENOENT silently; logs other errors. */
export function readJson<T>(path: string, errLabel?: string): T | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		console.error(`[tcc${errLabel ? ` ${errLabel}` : ""}] failed to read ${path}: ${(err as Error).message}`);
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		console.error(`[tcc${errLabel ? ` ${errLabel}` : ""}] failed to parse ${path}: ${(err as Error).message}`);
		return undefined;
	}
}

/** Read a tcc config file from the global location and (when inside a git repo) the per-project location. */
export function loadTccConfig<T>(filename: string, cwd: string, errLabel?: string): { global: T | undefined; project: T | undefined } {
	const global = readJson<T>(join(userConfigDir(), filename), errLabel);
	const root = findGitRoot(cwd);
	const project = root ? readJson<T>(join(root, ".tcc", filename), errLabel) : undefined;
	return { global, project };
}

/** Atomic file write: write to a sibling tempfile and rename over the target. */
export function writeJsonAtomic(path: string, data: unknown): void {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export interface RunProcessOptions {
	cmd: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** When true, child stdio is inherited (no stdout/stderr capture). Default false. */
	inheritStdio?: boolean;
}

export type RunReason = "exit" | "timeout" | "abort" | "spawnError";

export interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	reason: RunReason;
}

/** Async child-process runner with SIGTERM-on-timeout, SIGKILL escalation, abort handling,
 *  and explicit completion reason. Stdout/stderr are captured unless `inheritStdio` is set. */
export function runProcess(opts: RunProcessOptions): Promise<RunResult> {
	const timeoutMs = opts.timeoutMs ?? 30_000;
	return new Promise((resolve) => {
		if (opts.signal?.aborted) {
			resolve({ stdout: "", stderr: "aborted before spawn", exitCode: null, signal: null, reason: "abort" });
			return;
		}
		const child = spawn(opts.cmd, opts.args ?? [], {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: opts.inheritStdio ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let reason: RunReason = "exit";

		if (!opts.inheritStdio) {
			child.stdout?.on("data", (d) => {
				stdout += d.toString();
			});
			child.stderr?.on("data", (d) => {
				stderr += d.toString();
			});
		}

		const softTimer = setTimeout(() => {
			reason = "timeout";
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);

		const onAbort = () => {
			reason = "abort";
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000);
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			clearTimeout(softTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			stderr += `\n${err.message}`;
			resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: null, signal: null, reason: reason === "exit" ? "spawnError" : reason });
		});
		child.on("close", (code, sig) => {
			clearTimeout(softTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, signal: sig, reason });
		});
	});
}
