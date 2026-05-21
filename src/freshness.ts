import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findGitRoot, userConfigDir } from "./config.ts";
import { runProcess } from "./util.ts";

const CACHE_DIR = join(userConfigDir(), "research-cache");
const USER_AGENT = "tcc-freshness/0.1 (+https://github.com/mpurdon/tcc-harness)";
const TTL_HOURLY_MS = 60 * 60 * 1000;
const TTL_PACKAGE_MS = 6 * 60 * 60 * 1000;
const AWS_WHATS_NEW_FEED = "https://aws.amazon.com/about-aws/whats-new/recent/feed/";
const SYNTH_TIMEOUT_MS = 90_000;

export type Ecosystem = "npm" | "pypi" | "cargo" | "go" | "rubygems";

export interface Dependency {
	name: string;
	ecosystem: Ecosystem;
	current: string;
	manifest: string;
}

export interface LatestInfo {
	name: string;
	ecosystem: Ecosystem;
	latest: string;
	repoUrl?: string;
	homepageUrl?: string;
	releasedAt?: string;
}

interface CacheEntry<T> {
	cachedAt: number;
	ttlMs: number;
	data: T;
}

function cacheKey(parts: string[]): string {
	return createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
}

function cacheRead<T>(key: string): T | undefined {
	if (process.env.TCC_RESEARCH_NO_CACHE === "1") return undefined;
	const path = join(CACHE_DIR, `${key}.json`);
	if (!existsSync(path)) return undefined;
	try {
		const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<T>;
		if (Date.now() - entry.cachedAt > entry.ttlMs) return undefined;
		return entry.data;
	} catch {
		return undefined;
	}
}

function cacheWrite<T>(key: string, data: T, ttlMs: number): void {
	if (process.env.TCC_RESEARCH_NO_CACHE === "1") return;
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ cachedAt: Date.now(), ttlMs, data }));
	} catch {
		// best effort
	}
}

async function httpGetJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15_000);
	signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, redirect: "follow" });
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

async function httpGetText(url: string, signal?: AbortSignal): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15_000);
	signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

// ---------- package_latest ----------

async function latestNpm(name: string, signal?: AbortSignal): Promise<LatestInfo> {
	const json = await httpGetJson<{ version: string; repository?: { url?: string }; homepage?: string }>(
		`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
		signal,
	);
	return { name, ecosystem: "npm", latest: json.version, repoUrl: normalizeRepoUrl(json.repository?.url), homepageUrl: json.homepage };
}

async function latestPypi(name: string, signal?: AbortSignal): Promise<LatestInfo> {
	const json = await httpGetJson<{
		info: { version: string; project_urls?: Record<string, string>; home_page?: string };
		releases: Record<string, { upload_time?: string }[]>;
	}>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, signal);
	const version = json.info.version;
	const urls = json.info.project_urls ?? {};
	const repoUrl = pickFirstUrl(urls, ["Repository", "Source", "Source Code", "Homepage", "GitHub"]);
	const releases = json.releases?.[version];
	const releasedAt = releases?.[0]?.upload_time;
	return { name, ecosystem: "pypi", latest: version, repoUrl: normalizeRepoUrl(repoUrl), homepageUrl: json.info.home_page, releasedAt };
}

async function latestCargo(name: string, signal?: AbortSignal): Promise<LatestInfo> {
	const json = await httpGetJson<{ crate: { max_stable_version?: string; max_version: string; repository?: string; homepage?: string } }>(
		`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
		signal,
	);
	return {
		name,
		ecosystem: "cargo",
		latest: json.crate.max_stable_version ?? json.crate.max_version,
		repoUrl: normalizeRepoUrl(json.crate.repository),
		homepageUrl: json.crate.homepage,
	};
}

async function latestGo(modulePath: string, signal?: AbortSignal): Promise<LatestInfo> {
	const escaped = modulePath.replace(/([A-Z])/g, "!$1").toLowerCase();
	const json = await httpGetJson<{ Version: string; Time?: string }>(`https://proxy.golang.org/${escaped}/@latest`, signal);
	const repoUrl = modulePath.startsWith("github.com/") ? `https://${modulePath}` : undefined;
	return { name: modulePath, ecosystem: "go", latest: json.Version, repoUrl, releasedAt: json.Time };
}

async function latestRubygems(name: string, signal?: AbortSignal): Promise<LatestInfo> {
	const json = await httpGetJson<{ version: string; source_code_uri?: string; homepage_uri?: string }>(
		`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`,
		signal,
	);
	return { name, ecosystem: "rubygems", latest: json.version, repoUrl: normalizeRepoUrl(json.source_code_uri), homepageUrl: json.homepage_uri };
}

function pickFirstUrl(obj: Record<string, string>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = obj[k] ?? obj[k.toLowerCase()];
		if (v) return v;
	}
	for (const v of Object.values(obj)) {
		if (v && /github\.com|gitlab\.com|bitbucket/i.test(v)) return v;
	}
	return undefined;
}

function normalizeRepoUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	let u = url.replace(/^git\+/, "").replace(/\.git$/, "");
	if (u.startsWith("git@github.com:")) u = `https://github.com/${u.slice("git@github.com:".length)}`;
	if (u.startsWith("git://")) u = `https://${u.slice("git://".length)}`;
	return u;
}

async function fetchLatest(eco: Ecosystem, name: string, signal?: AbortSignal): Promise<LatestInfo> {
	const key = cacheKey(["latest", eco, name]);
	const cached = cacheRead<LatestInfo>(key);
	if (cached) return cached;
	let info: LatestInfo;
	if (eco === "npm") info = await latestNpm(name, signal);
	else if (eco === "pypi") info = await latestPypi(name, signal);
	else if (eco === "cargo") info = await latestCargo(name, signal);
	else if (eco === "go") info = await latestGo(name, signal);
	else info = await latestRubygems(name, signal);
	cacheWrite(key, info, TTL_PACKAGE_MS);
	return info;
}

// ---------- manifest scanning ----------

function scanManifests(cwd: string): Dependency[] {
	const root = findGitRoot(cwd) ?? cwd;
	const out: Dependency[] = [];
	const pkgJson = join(root, "package.json");
	if (existsSync(pkgJson)) out.push(...parsePackageJson(pkgJson));
	const pyproject = join(root, "pyproject.toml");
	if (existsSync(pyproject)) out.push(...parsePyproject(pyproject));
	const reqs = join(root, "requirements.txt");
	if (existsSync(reqs)) out.push(...parseRequirements(reqs));
	const cargo = join(root, "Cargo.toml");
	if (existsSync(cargo)) out.push(...parseCargo(cargo));
	const gomod = join(root, "go.mod");
	if (existsSync(gomod)) out.push(...parseGoMod(gomod));
	const gemfile = join(root, "Gemfile");
	if (existsSync(gemfile)) out.push(...parseGemfile(gemfile));
	return dedupDeps(out);
}

function dedupDeps(deps: Dependency[]): Dependency[] {
	const seen = new Map<string, Dependency>();
	for (const d of deps) {
		seen.set(`${d.ecosystem}:${d.name}`, d);
	}
	return [...seen.values()];
}

function parsePackageJson(path: string): Dependency[] {
	try {
		const json = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
		const sections = [json.dependencies, json.devDependencies, json.peerDependencies];
		const out: Dependency[] = [];
		for (const sec of sections) {
			if (!sec) continue;
			for (const [name, current] of Object.entries(sec)) {
				out.push({ name, ecosystem: "npm", current: cleanVersionSpec(current), manifest: path });
			}
		}
		return out;
	} catch {
		return [];
	}
}

function parsePyproject(path: string): Dependency[] {
	const out: Dependency[] = [];
	try {
		const raw = readFileSync(path, "utf8");
		// PEP 621 [project] dependencies = ["name>=1.0", ...]
		const projectDeps = /\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/.exec(raw);
		if (projectDeps) {
			for (const line of projectDeps[1].split(/[,\n]/)) {
				const m = /["']([A-Za-z0-9._-]+)\s*([<>=~!^]+\s*[A-Za-z0-9._+!-]+)?["']/.exec(line);
				if (m) out.push({ name: m[1], ecosystem: "pypi", current: m[2]?.replace(/\s/g, "") ?? "*", manifest: path });
			}
		}
		// Poetry: [tool.poetry.dependencies] name = "spec"
		const poetrySection = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(raw);
		if (poetrySection) {
			const lineRe = /^([A-Za-z0-9._-]+)\s*=\s*["']([^"']+)["']/gm;
			let m: RegExpExecArray | null = lineRe.exec(poetrySection[1]);
			while (m) {
				if (m[1].toLowerCase() !== "python") out.push({ name: m[1], ecosystem: "pypi", current: m[2], manifest: path });
				m = lineRe.exec(poetrySection[1]);
			}
		}
	} catch {
		// ignore
	}
	return out;
}

function parseRequirements(path: string): Dependency[] {
	try {
		const out: Dependency[] = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const trimmed = line.replace(/#.*$/, "").trim();
			if (!trimmed || trimmed.startsWith("-")) continue;
			const m = /^([A-Za-z0-9._-]+)\s*([<>=~!]=?\s*[A-Za-z0-9._+!-]+)?/.exec(trimmed);
			if (m) out.push({ name: m[1], ecosystem: "pypi", current: m[2]?.replace(/\s/g, "") ?? "*", manifest: path });
		}
		return out;
	} catch {
		return [];
	}
}

function parseCargo(path: string): Dependency[] {
	const out: Dependency[] = [];
	try {
		const raw = readFileSync(path, "utf8");
		const sectionRe = /\[(?:dependencies|dev-dependencies|build-dependencies)\]([\s\S]*?)(?:\n\[|$)/g;
		let sec: RegExpExecArray | null = sectionRe.exec(raw);
		while (sec) {
			const lineRe = /^([A-Za-z0-9_-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\})/gm;
			let m: RegExpExecArray | null = lineRe.exec(sec[1]);
			while (m) {
				out.push({ name: m[1], ecosystem: "cargo", current: m[2] ?? m[3] ?? "*", manifest: path });
				m = lineRe.exec(sec[1]);
			}
			sec = sectionRe.exec(raw);
		}
	} catch {
		// ignore
	}
	return out;
}

function parseGoMod(path: string): Dependency[] {
	const out: Dependency[] = [];
	try {
		const raw = readFileSync(path, "utf8");
		const requireBlock = /require\s*\(([\s\S]*?)\)/.exec(raw);
		const inlineRe = /require\s+(\S+)\s+(\S+)/g;
		if (requireBlock) {
			for (const line of requireBlock[1].split("\n")) {
				const m = /^\s*(\S+)\s+(\S+)/.exec(line);
				if (m && !line.includes("//")) out.push({ name: m[1], ecosystem: "go", current: m[2], manifest: path });
			}
		}
		let m: RegExpExecArray | null = inlineRe.exec(raw);
		while (m) {
			out.push({ name: m[1], ecosystem: "go", current: m[2], manifest: path });
			m = inlineRe.exec(raw);
		}
	} catch {
		// ignore
	}
	return out;
}

function parseGemfile(path: string): Dependency[] {
	try {
		const out: Dependency[] = [];
		const re = /gem\s+["']([A-Za-z0-9_-]+)["'](?:\s*,\s*["']([^"']+)["'])?/g;
		const raw = readFileSync(path, "utf8");
		let m: RegExpExecArray | null = re.exec(raw);
		while (m) {
			out.push({ name: m[1], ecosystem: "rubygems", current: m[2] ?? "*", manifest: path });
			m = re.exec(raw);
		}
		return out;
	} catch {
		return [];
	}
}

function cleanVersionSpec(v: string): string {
	return v.replace(/^[~^>=<]+/, "").trim();
}

// ---------- semver gap ----------

type Gap = "current" | "patch" | "minor" | "major" | "unknown";

function classifyGap(current: string, latest: string): Gap {
	const c = parseSemver(current);
	const l = parseSemver(latest);
	if (!c || !l) return "unknown";
	if (c.major === l.major && c.minor === l.minor && c.patch === l.patch) return "current";
	if (c.major !== l.major) return "major";
	if (c.minor !== l.minor) return "minor";
	return "patch";
}

function parseSemver(v: string): { major: number; minor: number; patch: number } | undefined {
	const cleaned = v.replace(/^v/, "").split(/[-+]/)[0];
	const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(cleaned);
	if (!m) return undefined;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

// ---------- AWS What's New ----------

interface AwsAnnouncement {
	title: string;
	link: string;
	pubDate: string;
	description: string;
}

async function fetchAwsWhatsNew(signal?: AbortSignal): Promise<AwsAnnouncement[]> {
	const key = cacheKey(["aws-whats-new", "v1"]);
	const cached = cacheRead<AwsAnnouncement[]>(key);
	if (cached) return cached;
	const xml = await httpGetText(AWS_WHATS_NEW_FEED, signal);
	const items: AwsAnnouncement[] = [];
	const itemRe = /<item>([\s\S]*?)<\/item>/g;
	let m: RegExpExecArray | null = itemRe.exec(xml);
	while (m) {
		const block = m[1];
		items.push({
			title: rssField(block, "title"),
			link: rssField(block, "link"),
			pubDate: rssField(block, "pubDate"),
			description: rssField(block, "description").replace(/<[^>]+>/g, "").trim(),
		});
		m = itemRe.exec(xml);
	}
	cacheWrite(key, items, TTL_HOURLY_MS);
	return items;
}

function rssField(block: string, field: string): string {
	const re = new RegExp(`<${field}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${field}>`);
	const m = re.exec(block);
	return m ? m[1].trim() : "";
}

// ---------- evaluate_upgrade synthesis ----------

function resolveHaiku(): string | undefined {
	return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
}

interface UpgradeInput {
	ecosystem: Ecosystem;
	name: string;
	current: string;
	latest: string;
	releaseNotes: string;
	usageSnippets: string;
	signal?: AbortSignal;
}

const UPGRADE_SYSTEM = [
	"You are an upgrade advisor.",
	"Given a library, its current and latest versions, recent release notes, and how it's currently used in the project,",
	"recommend whether to upgrade and which new features (if any) are relevant.",
	"Structure your answer:",
	"## Verdict",
	"One of: UPGRADE NOW · UPGRADE WHEN CONVENIENT · NO CHANGE NEEDED · CAUTION (breaking changes).",
	"## Relevant new features",
	"Bulleted list of features in the new versions that match the project's actual usage patterns. Skip anything unrelated.",
	"## Risks",
	"Breaking changes that affect this project, in 1-3 bullets. Be terse.",
	"## Suggested next step",
	"A single concrete action (e.g., 'bump to ^X in package.json and run tests', 'read migration guide at URL').",
	"Cap response at 400 words. No preamble.",
].join("\n");

async function synthesizeUpgrade(input: UpgradeInput): Promise<string> {
	const model = resolveHaiku();
	if (!model) return "(no Bedrock ARN — cannot synthesize)";
	const task = [
		`Library: ${input.name} (${input.ecosystem})`,
		`Current version: ${input.current}`,
		`Latest version: ${input.latest}`,
		"",
		"=== Recent release notes ===",
		input.releaseNotes,
		"",
		"=== How the project uses this library (grep snippets) ===",
		input.usageSnippets || "(no usage found in source)",
	].join("\n");
	const result = await runProcess({
		cmd: "pi",
		args: [
			"--print",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-themes",
			"--provider",
			"amazon-bedrock",
			"--model",
			model,
			"--system-prompt",
			UPGRADE_SYSTEM,
			task,
		],
		timeoutMs: SYNTH_TIMEOUT_MS,
		signal: input.signal,
	});
	if (result.reason !== "exit" || (result.exitCode !== 0 && result.exitCode !== null)) {
		return `(synthesis failed: ${result.reason}, exit ${result.exitCode})\nstderr tail: ${result.stderr.slice(-500)}`;
	}
	return result.stdout.trim() || "(no output)";
}

async function gatherReleaseNotes(repoUrl: string | undefined, signal: AbortSignal | undefined): Promise<string> {
	if (!repoUrl) return "(no repo URL on record — cannot fetch release notes)";
	const m = /github\.com\/([^/]+)\/([^/?#]+)/.exec(repoUrl);
	if (!m) return `(repo ${repoUrl} is not on GitHub — skipping release notes)`;
	const owner = m[1];
	const repo = m[2].replace(/\.git$/, "");
	const cacheK = cacheKey(["gh-releases", owner, repo, "5"]);
	const cached = cacheRead<string>(cacheK);
	if (cached) return cached;
	const result = await runProcess({
		cmd: "gh",
		args: ["api", `/repos/${owner}/${repo}/releases?per_page=5`],
		timeoutMs: 15_000,
		signal,
	});
	if (result.reason !== "exit" || result.exitCode !== 0) {
		return `(gh releases fetch failed: ${result.stderr.slice(0, 300)})`;
	}
	try {
		const releases = JSON.parse(result.stdout) as { tag_name?: string; name?: string; published_at?: string; body?: string }[];
		const formatted = releases
			.slice(0, 5)
			.map((r) => `### ${r.tag_name ?? r.name ?? "?"} (${r.published_at ?? "?"})\n${(r.body ?? "").slice(0, 1500)}`)
			.join("\n\n");
		cacheWrite(cacheK, formatted, TTL_HOURLY_MS);
		return formatted;
	} catch {
		return result.stdout.slice(0, 5000);
	}
}

async function grepUsage(cwd: string, name: string, signal: AbortSignal | undefined): Promise<string> {
	const safe = name.replace(/[^A-Za-z0-9_./@-]/g, "");
	if (!safe) return "";
	const root = findGitRoot(cwd) ?? cwd;
	const result = await runProcess({
		cmd: "rg",
		args: ["-n", "--no-heading", "-S", "--max-count", "3", safe, root],
		timeoutMs: 10_000,
		signal,
	});
	if (result.reason !== "exit") return "";
	return result.stdout.split("\n").slice(0, 40).join("\n");
}

// ---------- extension ----------

export default function freshnessExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aws_whats_new",
		label: "AWS What's New",
		description:
			"Fetch the AWS 'What's New' announcements RSS feed and optionally filter by service substring and recency window. " +
			"Use this to discover newly-released or generally-available AWS services and features.",
		parameters: Type.Object({
			service: Type.Optional(Type.String({ description: "Case-insensitive substring filter (e.g., 'lambda', 'bedrock', 'durable')." })),
			since_days: Type.Optional(Type.Number({ description: "Only include items published within the last N days." })),
			limit: Type.Optional(Type.Number({ description: "Max items to return (default 25)." })),
		}),
		async execute(_id, params, signal) {
			try {
				const items = await fetchAwsWhatsNew(signal);
				return { content: [{ type: "text", text: formatAws(items, params) }], details: undefined };
			} catch (err) {
				return { content: [{ type: "text", text: `aws_whats_new failed: ${(err as Error).message}` }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "github_releases",
		label: "GitHub releases",
		description:
			"List recent releases for a GitHub repo via the gh CLI (must be installed and authenticated). " +
			"Useful for tracking library updates with full release notes.",
		parameters: Type.Object({
			repo: Type.String({ description: "Repo in 'owner/name' form, e.g., 'strands-agents/sdk-python'." }),
			limit: Type.Optional(Type.Number({ description: "Max releases (default 5, max 20)." })),
		}),
		async execute(_id, params, signal) {
			const limit = Math.min(params.limit ?? 5, 20);
			const result = await runProcess({
				cmd: "gh",
				args: ["api", `/repos/${params.repo}/releases?per_page=${limit}`],
				timeoutMs: 15_000,
				signal,
			});
			if (result.reason !== "exit" || result.exitCode !== 0) {
				return { content: [{ type: "text", text: `gh failed: ${result.stderr.slice(0, 600) || result.reason}` }], details: undefined, isError: true };
			}
			return { content: [{ type: "text", text: formatReleases(result.stdout) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "package_latest",
		label: "Package latest version",
		description:
			"Look up the latest published version of a package on its registry (npm, pypi, cargo, go, rubygems). " +
			"Returns version, repo URL, and (when available) release date.",
		parameters: Type.Object({
			ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("pypi"), Type.Literal("cargo"), Type.Literal("go"), Type.Literal("rubygems")]),
			name: Type.String({ description: "Package name as listed on the registry. For go, use the full module path (e.g., 'github.com/aws/aws-sdk-go-v2')." }),
		}),
		async execute(_id, params, signal) {
			try {
				const info = await fetchLatest(params.ecosystem, params.name, signal);
				return { content: [{ type: "text", text: formatLatest(info) }], details: undefined };
			} catch (err) {
				return { content: [{ type: "text", text: `package_latest failed: ${(err as Error).message}` }], details: undefined, isError: true };
			}
		},
	});

	pi.registerTool({
		name: "check_freshness",
		label: "Check freshness",
		description:
			"Scan the project's manifest files (package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod, Gemfile) " +
			"and report which direct dependencies are behind their latest published version. " +
			"Sorted by gap severity (major → minor → patch). Use this to spot upgrade candidates.",
		parameters: Type.Object({
			ecosystem: Type.Optional(Type.String({ description: "Restrict to one ecosystem: npm|pypi|cargo|go|rubygems." })),
			name: Type.Optional(Type.String({ description: "Restrict to a single package name (case-insensitive substring match)." })),
			limit: Type.Optional(Type.Number({ description: "Max packages to look up (default 40, max 100). Costs one HTTP call each." })),
		}),
		renderCall: (_args, _theme, context) => {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText("📦 scanning manifests");
			return text;
		},
		async execute(_id, params, signal, _u, ctx) {
			const all = scanManifests(ctx.cwd);
			const filtered = filterDeps(all, params.ecosystem, params.name).slice(0, Math.min(params.limit ?? 40, 100));
			if (filtered.length === 0) {
				return { content: [{ type: "text", text: "No matching dependencies found in this repo's manifests." }], details: undefined };
			}
			const rows = await Promise.all(filtered.map(async (d) => withLatest(d, signal)));
			return { content: [{ type: "text", text: formatFreshness(rows) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "evaluate_upgrade",
		label: "Evaluate upgrade",
		description:
			"Deep-dive on whether to upgrade a single library. Fetches the latest version, pulls recent GitHub release notes, " +
			"greps the project for how the library is actually used, then asks a cheap fast model (Haiku) to recommend a verdict, " +
			"highlight relevant new features, and flag risks. Use this when `check_freshness` flags something interesting.",
		parameters: Type.Object({
			ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("pypi"), Type.Literal("cargo"), Type.Literal("go"), Type.Literal("rubygems")]),
			name: Type.String({ description: "Package name (or full go module path)." }),
			current: Type.Optional(Type.String({ description: "Override the current version (otherwise read from manifests)." })),
		}),
		renderCall: (args, _theme, context) => {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`🧪 evaluating ${args.name ?? "?"}`);
			return text;
		},
		async execute(_id, params, signal, _u, ctx) {
			const current = params.current ?? findCurrentVersion(ctx.cwd, params.ecosystem, params.name);
			if (!current) {
				return {
					content: [{ type: "text", text: `Could not find ${params.name} in any manifest. Pass 'current' explicitly to evaluate.` }],
					details: undefined,
					isError: true,
				};
			}
			ctx.ui.setStatus("tcc.research", `🧪 ${params.name}`);
			try {
				const latest = await fetchLatest(params.ecosystem, params.name, signal);
				const [releaseNotes, usage] = await Promise.all([
					gatherReleaseNotes(latest.repoUrl, signal),
					grepUsage(ctx.cwd, params.name, signal),
				]);
				const brief = await synthesizeUpgrade({
					ecosystem: params.ecosystem,
					name: params.name,
					current,
					latest: latest.latest,
					releaseNotes,
					usageSnippets: usage,
					signal,
				});
				const gap = classifyGap(current, latest.latest);
				const header = `[${params.ecosystem}:${params.name}] ${current} → ${latest.latest} (${gap})`;
				return { content: [{ type: "text", text: `${header}\n\n${brief}` }], details: undefined };
			} catch (err) {
				return { content: [{ type: "text", text: `evaluate_upgrade failed: ${(err as Error).message}` }], details: undefined, isError: true };
			} finally {
				ctx.ui.setStatus("tcc.research", undefined);
			}
		},
	});
}

function filterDeps(all: Dependency[], ecosystem?: string, name?: string): Dependency[] {
	let out = all;
	if (ecosystem) out = out.filter((d) => d.ecosystem === ecosystem);
	if (name) {
		const needle = name.toLowerCase();
		out = out.filter((d) => d.name.toLowerCase().includes(needle));
	}
	return out;
}

interface FreshnessRow {
	dep: Dependency;
	latest?: string;
	gap: Gap;
	error?: string;
}

async function withLatest(dep: Dependency, signal: AbortSignal | undefined): Promise<FreshnessRow> {
	try {
		const info = await fetchLatest(dep.ecosystem, dep.name, signal);
		return { dep, latest: info.latest, gap: classifyGap(dep.current, info.latest) };
	} catch (err) {
		return { dep, gap: "unknown", error: (err as Error).message };
	}
}

function findCurrentVersion(cwd: string, ecosystem: Ecosystem, name: string): string | undefined {
	const all = scanManifests(cwd);
	return all.find((d) => d.ecosystem === ecosystem && d.name === name)?.current;
}

function formatLatest(info: LatestInfo): string {
	const lines = [`${info.ecosystem}:${info.name} → ${info.latest}`];
	if (info.releasedAt) lines.push(`Released: ${info.releasedAt}`);
	if (info.repoUrl) lines.push(`Repo: ${info.repoUrl}`);
	if (info.homepageUrl) lines.push(`Homepage: ${info.homepageUrl}`);
	return lines.join("\n");
}

function formatFreshness(rows: FreshnessRow[]): string {
	const order: Gap[] = ["major", "minor", "patch", "unknown", "current"];
	rows.sort((a, b) => order.indexOf(a.gap) - order.indexOf(b.gap));
	const lines = ["package                                           current → latest        gap"];
	for (const r of rows) {
		const left = `${r.dep.ecosystem}:${r.dep.name}`.padEnd(50);
		const versions = r.latest ? `${r.dep.current} → ${r.latest}`.padEnd(24) : `${r.dep.current} → ?`.padEnd(24);
		const tag = r.error ? `err: ${r.error.slice(0, 40)}` : r.gap;
		lines.push(`${left}${versions}${tag}`);
	}
	return lines.join("\n");
}

function formatAws(items: AwsAnnouncement[], opts: { service?: string; since_days?: number; limit?: number }): string {
	const limit = opts.limit ?? 25;
	let filtered = items;
	if (opts.service) {
		const needle = opts.service.toLowerCase();
		filtered = filtered.filter((i) => i.title.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle));
	}
	if (opts.since_days) {
		const cutoff = Date.now() - opts.since_days * 24 * 60 * 60 * 1000;
		filtered = filtered.filter((i) => {
			const t = Date.parse(i.pubDate);
			return Number.isFinite(t) && t >= cutoff;
		});
	}
	const top = filtered.slice(0, limit);
	if (top.length === 0) return "No AWS announcements matched.";
	const lines = [`${top.length} of ${items.length} AWS announcements:`, ""];
	for (const i of top) {
		lines.push(`- ${i.pubDate} — ${i.title}`);
		lines.push(`  ${i.link}`);
		if (i.description) lines.push(`  ${i.description.slice(0, 200)}`);
	}
	return lines.join("\n");
}

function formatReleases(rawJson: string): string {
	try {
		const releases = JSON.parse(rawJson) as { tag_name?: string; name?: string; published_at?: string; body?: string; html_url?: string }[];
		const lines = [`${releases.length} releases:`, ""];
		for (const r of releases) {
			lines.push(`### ${r.tag_name ?? r.name ?? "?"} (${r.published_at ?? "?"})`);
			if (r.html_url) lines.push(r.html_url);
			if (r.body) lines.push((r.body.length > 1500 ? `${r.body.slice(0, 1500)}…` : r.body).trim());
			lines.push("");
		}
		return lines.join("\n");
	} catch {
		return rawJson.slice(0, 5000);
	}
}
