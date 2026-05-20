#!/usr/bin/env node
// Read ~/.tcc/auth-log.jsonl and print a readable summary of AWS SSO auth history.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = join(homedir(), ".tcc", "auth-log.jsonl");

function readEvents() {
	let raw;
	try {
		raw = readFileSync(LOG_PATH, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
	const out = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e && e.ts && e.event) out.push({ ...e, t: Date.parse(e.ts) });
		} catch {
			// skip malformed line
		}
	}
	return out.sort((a, b) => a.t - b.t);
}

function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rem = m % 60;
	if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const hRem = h % 24;
	return hRem ? `${d}d ${hRem}h` : `${d}d`;
}

function percentile(sortedAsc, p) {
	if (sortedAsc.length === 0) return NaN;
	const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
	return sortedAsc[idx];
}

function stats(events) {
	const byType = new Map();
	for (const e of events) byType.set(e.event, (byType.get(e.event) ?? 0) + 1);

	const successes = events.filter((e) => e.event === "login_success");
	const lifetimes = [];
	for (let i = 1; i < successes.length; i++) lifetimes.push(successes[i].t - successes[i - 1].t);
	lifetimes.sort((a, b) => a - b);

	const now = Date.now();
	const last24h = events.filter((e) => now - e.t < 24 * 3600_000).length;
	const last7d = events.filter((e) => now - e.t < 7 * 24 * 3600_000).length;
	const last30d = events.filter((e) => now - e.t < 30 * 24 * 3600_000).length;

	const lastSuccess = successes[successes.length - 1];
	const lastEvent = events[events.length - 1];

	// Histogram by day-of-week for successful logins (where 0=Sun, 6=Sat).
	const dow = new Array(7).fill(0);
	for (const s of successes) dow[new Date(s.t).getDay()] += 1;

	// Time-since-last-login distribution buckets.
	const buckets = { "<1h": 0, "1-4h": 0, "4-8h": 0, "8-24h": 0, ">24h": 0 };
	for (const ms of lifetimes) {
		const h = ms / 3600_000;
		if (h < 1) buckets["<1h"] += 1;
		else if (h < 4) buckets["1-4h"] += 1;
		else if (h < 8) buckets["4-8h"] += 1;
		else if (h < 24) buckets["8-24h"] += 1;
		else buckets[">24h"] += 1;
	}

	return {
		total: events.length,
		byType: Object.fromEntries(byType),
		successCount: successes.length,
		lastSuccess,
		lastEvent,
		recent: { last24h, last7d, last30d },
		lifetimes: {
			count: lifetimes.length,
			mean: lifetimes.length ? lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length : NaN,
			median: percentile(lifetimes, 0.5),
			p95: percentile(lifetimes, 0.95),
			min: lifetimes[0] ?? NaN,
			max: lifetimes[lifetimes.length - 1] ?? NaN,
		},
		dow,
		buckets,
	};
}

function fmtDow(dow) {
	const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const max = Math.max(1, ...dow);
	return labels.map((label, i) => `  ${label}: ${"▇".repeat(Math.round((dow[i] / max) * 12)).padEnd(12)} ${dow[i]}`).join("\n");
}

function render(events) {
	if (events.length === 0) {
		return "No auth events recorded yet. Tcc starts logging the first time you log in via the wrapper, `tcc login`, or `/login`.";
	}
	const s = stats(events);
	const lines = [];
	lines.push(`## AWS SSO auth history  (${LOG_PATH})`);
	lines.push("");
	lines.push(`total events: ${s.total}    (last 24h: ${s.recent.last24h} · 7d: ${s.recent.last7d} · 30d: ${s.recent.last30d})`);
	const byTypeStr = Object.entries(s.byType)
		.map(([k, v]) => `${k}=${v}`)
		.join("  ");
	lines.push(`by type:      ${byTypeStr}`);
	if (s.lastSuccess) {
		lines.push(`last login:   ${s.lastSuccess.ts}  (${formatDuration(Date.now() - s.lastSuccess.t)} ago, profile=${s.lastSuccess.profile})`);
	}
	if (s.lastEvent && s.lastEvent !== s.lastSuccess) {
		lines.push(`last event:   ${s.lastEvent.event} @ ${s.lastEvent.ts}  (${formatDuration(Date.now() - s.lastEvent.t)} ago)`);
	}
	lines.push("");
	lines.push("## session lifetime (gap between successive successful logins)");
	if (s.lifetimes.count === 0) {
		lines.push("  not enough successful logins yet (need ≥2)");
	} else {
		lines.push(`  n=${s.lifetimes.count}`);
		lines.push(`  mean   ${formatDuration(s.lifetimes.mean)}`);
		lines.push(`  median ${formatDuration(s.lifetimes.median)}`);
		lines.push(`  p95    ${formatDuration(s.lifetimes.p95)}`);
		lines.push(`  min    ${formatDuration(s.lifetimes.min)}     max  ${formatDuration(s.lifetimes.max)}`);
		lines.push("");
		lines.push("  distribution:");
		for (const [label, n] of Object.entries(s.buckets)) lines.push(`    ${label.padEnd(8)} ${n}`);
	}
	lines.push("");
	lines.push("## logins by day of week");
	lines.push(fmtDow(s.dow));
	return lines.join("\n");
}

const events = readEvents();
process.stdout.write(`${render(events)}\n`);
