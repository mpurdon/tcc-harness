import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// User-facing notification categories. Pick names that match the *moment* the
// user is reacting to, not the underlying event source — that keeps the config
// file readable and makes "I want to swap the question sound" obvious.
export type NotifyType = "question" | "permission" | "error" | "done" | "compact";

interface NotifyConfig {
	enabled: boolean;
	/** macOS Notification Center banners via osascript (in addition to the sound). */
	banners: boolean;
	/** Map of category → /System/Library/Sounds/<name>.aiff stem ("Hero"), absolute path, or ~/path. */
	sounds: Record<NotifyType, string>;
	/** Skip the "done" notification if the turn took fewer seconds than this — avoids noise on tiny turns. */
	doneMinSeconds: number;
	/** Per-category cooldown in milliseconds. Defends against spammy categories (errors during a fan-out). */
	cooldownMs: number;
	/** macOS `say` voice name used by /tcc:notify generate. See `/tcc:notify voices`. */
	voice: string;
	/** Words-per-minute for macOS `say`. Default 175 (the say default). */
	rate: number;
	/** Text rendered into audio per category by /tcc:notify generate. Edit to taste. */
	lines: Record<NotifyType, string>;
	/** Optional: ElevenLabs voice id. When set + ELEVENLABS_API_KEY in env, generate
	 *  uses ElevenLabs for higher-fidelity audio. Falls back to `say` if either is missing. */
	elevenLabsVoiceId?: string;
	/** ElevenLabs model id. Default eleven_multilingual_v2 (best for French + English). */
	elevenLabsModelId: string;
}

const DEFAULTS: NotifyConfig = {
	enabled: true,
	banners: true,
	sounds: {
		question: "Hero",
		permission: "Sosumi",
		error: "Basso",
		done: "Glass",
		compact: "Tink",
	},
	doneMinSeconds: 30,
	cooldownMs: 2_000,
	voice: "Thomas",
	rate: 175,
	lines: {
		question: "Pardonnez-moi, monsieur, j'ai une question.",
		permission: "Permission requise, s'il vous plaît.",
		error: "Oh là là! C'est une catastrophe!",
		done: "C'est fini! Voilà!",
		compact: "Compactage terminé.",
	},
	elevenLabsModelId: "eleven_multilingual_v2",
};

const NOTIFY_TYPES: NotifyType[] = ["question", "permission", "error", "done", "compact"];

let runtimeConfig: NotifyConfig = DEFAULTS;
const lastFiredAt = new Map<NotifyType, number>();

const CONFIG_PATH = join(homedir(), ".tcc", "notify.json");
const SOUNDS_DIR = join(homedir(), ".tcc", "sounds");

function loadConfig(): NotifyConfig {
	// Strategy: shallow-merge a user file (if present) over DEFAULTS so a user
	// who only wants to swap the "error" sound doesn't have to re-state the
	// other categories. Bad JSON → fall back to defaults with a stderr note,
	// don't crash the whole extension load.
	if (!existsSync(CONFIG_PATH)) return DEFAULTS;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<NotifyConfig>;
		return {
			enabled: raw.enabled ?? DEFAULTS.enabled,
			banners: raw.banners ?? DEFAULTS.banners,
			sounds: { ...DEFAULTS.sounds, ...(raw.sounds ?? {}) },
			doneMinSeconds: raw.doneMinSeconds ?? DEFAULTS.doneMinSeconds,
			cooldownMs: raw.cooldownMs ?? DEFAULTS.cooldownMs,
			voice: raw.voice ?? DEFAULTS.voice,
			rate: raw.rate ?? DEFAULTS.rate,
			lines: { ...DEFAULTS.lines, ...(raw.lines ?? {}) },
			elevenLabsVoiceId: raw.elevenLabsVoiceId ?? DEFAULTS.elevenLabsVoiceId,
			elevenLabsModelId: raw.elevenLabsModelId ?? DEFAULTS.elevenLabsModelId,
		};
	} catch (err) {
		console.error(`[tcc notify] failed to parse ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)} — using defaults`);
		return DEFAULTS;
	}
}

function writeConfig(cfg: NotifyConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
	return path;
}

function resolveSoundPath(sound: string): string | undefined {
	// Absolute path (or ~/path) → expand + check; bare name → /System/Library/Sounds/<n>.aiff.
	// Anything else (relative path, unknown name) falls back to the system dir
	// since that's the most common knob and a typo there is easy to fix.
	if (sound.startsWith("/") || sound.startsWith("~")) {
		const expanded = expandHome(sound);
		return existsSync(expanded) ? expanded : undefined;
	}
	const candidate = `/System/Library/Sounds/${sound}.aiff`;
	return existsSync(candidate) ? candidate : undefined;
}

function playSound(sound: string): void {
	const path = resolveSoundPath(sound);
	if (!path) return;
	// Fire-and-forget. Detached + unref so a hanging afplay can't keep node alive.
	// stdio: "ignore" so afplay's chatter doesn't pollute the TUI.
	try {
		const child = spawn("/usr/bin/afplay", [path], { stdio: "ignore", detached: true });
		child.unref();
		child.on("error", () => undefined);
	} catch {
		// afplay missing or sandboxed — silent failure is fine, sound is non-critical.
	}
}

// Cached at module load: `osascript display notification` always attributes to
// Script Editor (so clicks open that), but if the user has terminal-notifier
// installed we can attribute to their actual terminal and clicks bring it
// forward. `/tcc:notify status` surfaces which backend is active so users know
// the upgrade path without us nagging on every banner.
type BannerBackend = { kind: "terminal-notifier"; path: string } | { kind: "osascript" };
let bannerBackendCache: BannerBackend | undefined;

function detectBannerBackend(): BannerBackend {
	if (bannerBackendCache) return bannerBackendCache;
	for (const p of ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) {
		if (existsSync(p)) {
			bannerBackendCache = { kind: "terminal-notifier", path: p };
			return bannerBackendCache;
		}
	}
	bannerBackendCache = { kind: "osascript" };
	return bannerBackendCache;
}

// TERM_PROGRAM → bundle id. Used as `-sender` for terminal-notifier so the
// banner shows the terminal's icon and clicking activates the terminal. If we
// don't recognize the terminal, omit -sender and terminal-notifier uses its
// own bundle (still better than Script Editor since clicks are harmless).
function terminalBundleId(): string | undefined {
	const t = process.env.TERM_PROGRAM;
	if (!t) return undefined;
	const map: Record<string, string> = {
		WezTerm: "com.github.wez.wezterm",
		"iTerm.app": "com.googlecode.iterm2",
		Apple_Terminal: "com.apple.Terminal",
		vscode: "com.microsoft.VSCode",
		ghostty: "com.mitchellh.ghostty",
	};
	return map[t];
}

function showBanner(type: NotifyType, summary: string | undefined): void {
	const title = `tcc — ${type}`;
	const body = (summary && summary.length > 0 ? summary : type).slice(0, 200);
	const backend = detectBannerBackend();
	try {
		if (backend.kind === "terminal-notifier") {
			const args = ["-title", title, "-message", body];
			const sender = terminalBundleId();
			if (sender) args.push("-sender", sender);
			const child = spawn(backend.path, args, { stdio: "ignore", detached: true });
			child.unref();
			child.on("error", () => undefined);
			return;
		}
		// osascript fallback. Escape embedded quotes; we already truncated body.
		const escapedBody = body.replace(/"/g, '\\"');
		const escapedTitle = title.replace(/"/g, '\\"');
		const child = spawn("/usr/bin/osascript", ["-e", `display notification "${escapedBody}" with title "${escapedTitle}"`], { stdio: "ignore", detached: true });
		child.unref();
		child.on("error", () => undefined);
	} catch {
		// osascript / terminal-notifier missing or sandboxed — non-fatal.
	}
}

/** Public hook — used by permissions.ts (and could be used by other extensions
 *  that want to surface a tcc-specific category beyond the auto-wired events). */
export function playNotification(type: NotifyType, summary?: string): void {
	const cfg = runtimeConfig;
	if (!cfg.enabled) return;
	if (platform() !== "darwin") return; // afplay/osascript are macOS-only
	const now = Date.now();
	const last = lastFiredAt.get(type) ?? 0;
	if (now - last < cfg.cooldownMs) return;
	lastFiredAt.set(type, now);
	const sound = cfg.sounds[type];
	if (sound) playSound(sound);
	if (cfg.banners) showBanner(type, summary);
}

interface GenerateOutcome {
	type: NotifyType;
	backend: "elevenlabs" | "say" | "skipped";
	path?: string;
	error?: string;
}

function spawnAndWait(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolveProm) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => resolveProm({ code, stderr }));
		child.on("error", (err) => resolveProm({ code: null, stderr: err.message }));
	});
}

async function renderWithSay(text: string, voice: string, rate: number, outPath: string): Promise<{ ok: boolean; error?: string }> {
	const r = await spawnAndWait("/usr/bin/say", ["-v", voice, "-r", String(rate), "-o", outPath, "--", text]);
	if (r.code !== 0) return { ok: false, error: `say exit ${r.code}: ${r.stderr.trim().slice(0, 200)}` };
	return { ok: true };
}

async function renderWithElevenLabs(text: string, voiceId: string, modelId: string, apiKey: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
	// ElevenLabs returns audio/mpeg. We write the bytes verbatim to a .mp3 path
	// (afplay handles mp3 natively on macOS). Network errors or non-2xx responses
	// fall back to the caller — usually a `say` retry — so a misconfigured key or
	// quota exhaustion doesn't leave the user with no sound at all.
	try {
		const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
			method: "POST",
			headers: {
				"xi-api-key": apiKey,
				"Content-Type": "application/json",
				Accept: "audio/mpeg",
			},
			body: JSON.stringify({ text, model_id: modelId }),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			return { ok: false, error: `elevenlabs ${res.status}: ${body.slice(0, 200)}` };
		}
		const buf = Buffer.from(await res.arrayBuffer());
		writeFileSync(outPath, buf);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `elevenlabs fetch failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

async function generateAll(cfg: NotifyConfig, force: boolean): Promise<GenerateOutcome[]> {
	mkdirSync(SOUNDS_DIR, { recursive: true });
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const useElevenLabs = Boolean(cfg.elevenLabsVoiceId && apiKey);
	const outcomes: GenerateOutcome[] = [];
	for (const type of NOTIFY_TYPES) {
		const text = cfg.lines[type];
		if (!text || text.trim().length === 0) {
			outcomes.push({ type, backend: "skipped", error: "empty line" });
			continue;
		}
		const ext = useElevenLabs ? "mp3" : "aiff";
		const outPath = join(SOUNDS_DIR, `${type}.${ext}`);
		if (!force && existsSync(outPath)) {
			outcomes.push({ type, backend: useElevenLabs ? "elevenlabs" : "say", path: outPath });
			continue;
		}
		if (useElevenLabs) {
			const r = await renderWithElevenLabs(text, cfg.elevenLabsVoiceId as string, cfg.elevenLabsModelId, apiKey as string, outPath);
			if (r.ok) {
				outcomes.push({ type, backend: "elevenlabs", path: outPath });
				continue;
			}
			// EL failure → fall back to say so the user still gets a working sound.
			const fb = await renderWithSay(text, cfg.voice, cfg.rate, join(SOUNDS_DIR, `${type}.aiff`));
			if (fb.ok) outcomes.push({ type, backend: "say", path: join(SOUNDS_DIR, `${type}.aiff`), error: `EL failed: ${r.error}` });
			else outcomes.push({ type, backend: "skipped", error: `EL: ${r.error}; say: ${fb.error}` });
			continue;
		}
		const r = await renderWithSay(text, cfg.voice, cfg.rate, outPath);
		if (r.ok) outcomes.push({ type, backend: "say", path: outPath });
		else outcomes.push({ type, backend: "skipped", error: r.error });
	}
	return outcomes;
}

async function handleGenerate(cfg: NotifyConfig, force: boolean, ctx: ExtensionCommandContext): Promise<void> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const useElevenLabs = Boolean(cfg.elevenLabsVoiceId && apiKey);
	const backendLabel = useElevenLabs ? `ElevenLabs (voice ${cfg.elevenLabsVoiceId})` : `macOS say (voice ${cfg.voice})`;
	ctx.ui.notify(`generating ${NOTIFY_TYPES.length} sounds via ${backendLabel}…`, "info");

	const outcomes = await generateAll(cfg, force);

	// Update config in place: point each successful sound at its rendered path.
	const newSounds = { ...cfg.sounds };
	for (const o of outcomes) {
		if (o.path) newSounds[o.type] = o.path.replace(homedir(), "~");
	}
	const newCfg: NotifyConfig = { ...cfg, sounds: newSounds };
	writeConfig(newCfg);
	runtimeConfig = newCfg;

	const lines: string[] = ["## generate results"];
	for (const o of outcomes) {
		const tag = o.backend === "skipped" ? "✗" : "✓";
		const detail = o.path ? o.path.replace(homedir(), "~") : o.error ?? "(no detail)";
		lines.push(`  ${tag} ${o.type.padEnd(11)} [${o.backend}] ${detail}`);
	}
	lines.push("");
	lines.push(`Updated ${CONFIG_PATH.replace(homedir(), "~")} with the rendered paths.`);
	lines.push("Test with: /tcc:notify test [question|permission|error|done|compact]");
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleVoices(ctx: ExtensionCommandContext): Promise<void> {
	const r = await new Promise<string>((resolveProm) => {
		const child = spawn("/usr/bin/say", ["-v", "?"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout?.on("data", (d) => {
			out += d.toString();
		});
		child.on("close", () => resolveProm(out));
		child.on("error", () => resolveProm(""));
	});
	if (!r) {
		ctx.ui.notify("could not list voices — `say -v ?` failed.", "error");
		return;
	}
	// Filter to French + English voices; the full list (170+) is too long for a notify panel.
	const wanted = r.split("\n").filter((line) => /\b(fr_FR|fr_CA|en_US|en_GB)\b/.test(line));
	const lines: string[] = ["## available say voices (French + English)"];
	lines.push("Edit `voice` in ~/.tcc/notify.json then run /tcc:notify generate --force");
	lines.push("");
	lines.push(...wanted.slice(0, 60));
	if (wanted.length > 60) lines.push(`... ${wanted.length - 60} more truncated; run \`say -v ?\` in a terminal for the full list`);
	ctx.ui.notify(lines.join("\n"), "info");
}

export default function notifyExtension(pi: ExtensionAPI): void {
	runtimeConfig = loadConfig();

	// Track agent_start timestamps per turn so we can suppress the "done" sound
	// on quick turns. Keyed by a single slot since pi runs one turn at a time
	// in interactive mode — agent_start fires before each agent loop.
	let agentStartedAt: number | undefined;

	pi.on("agent_start", () => {
		agentStartedAt = Date.now();
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const startedAt = agentStartedAt;
		agentStartedAt = undefined;
		if (startedAt === undefined) return;
		const seconds = (Date.now() - startedAt) / 1000;
		if (seconds < runtimeConfig.doneMinSeconds) return;
		playNotification("done", `agent finished after ${seconds.toFixed(0)}s`);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.toolName === "ask_user") {
			// Fires the moment the LLM commits to asking — wizard appears right after.
			playNotification("question", "ask_user pending");
		}
	});

	pi.registerCommand("tcc:notify", {
		description: "Show/test tcc desktop notifications. Subcommands: status (default) | test [type] | generate [--force] | voices | reload",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase() ?? "status";

			if (sub === "reload") {
				runtimeConfig = loadConfig();
				ctx.ui.notify("notify config reloaded from ~/.tcc/notify.json", "info");
				return;
			}

			if (sub === "generate") {
				const force = parts.includes("--force") || parts.includes("-f");
				await handleGenerate(runtimeConfig, force, ctx);
				return;
			}

			if (sub === "voices") {
				await handleVoices(ctx);
				return;
			}

			if (sub === "test") {
				const type = (parts[1] as NotifyType | undefined) ?? "question";
				if (!NOTIFY_TYPES.includes(type)) {
					ctx.ui.notify(`unknown type '${type}'. Valid: ${NOTIFY_TYPES.join(", ")}`, "error");
					return;
				}
				// Bypass the cooldown for manual tests so quick repeated test calls work.
				lastFiredAt.delete(type);
				playNotification(type, `test sound for "${type}"`);
				ctx.ui.notify(`played notification: ${type} (sound=${runtimeConfig.sounds[type]})`, "info");
				return;
			}

			const apiKey = process.env.ELEVENLABS_API_KEY;
			const useEL = Boolean(runtimeConfig.elevenLabsVoiceId && apiKey);
			const lines: string[] = ["## tcc notify"];
			lines.push(`enabled: ${runtimeConfig.enabled}`);
			lines.push(`banners: ${runtimeConfig.banners}`);
			lines.push(`doneMinSeconds: ${runtimeConfig.doneMinSeconds}`);
			lines.push(`cooldownMs: ${runtimeConfig.cooldownMs}`);
			lines.push(`voice (say): ${runtimeConfig.voice} @ ${runtimeConfig.rate} wpm`);
			lines.push(
				`elevenlabs: ${
					useEL
						? `voice=${runtimeConfig.elevenLabsVoiceId} model=${runtimeConfig.elevenLabsModelId}`
						: runtimeConfig.elevenLabsVoiceId
						? "voiceId set but ELEVENLABS_API_KEY missing (add to ~/.tcc/secrets.json)"
						: "(unset — using macOS say)"
				}`,
			);
			const banner = detectBannerBackend();
			const senderId = terminalBundleId();
			lines.push(
				`banner backend: ${
					banner.kind === "terminal-notifier"
						? `terminal-notifier${senderId ? ` (clicks → ${senderId})` : " (sender unknown — clicks are harmless)"}`
						: "osascript (clicks open Script Editor — `brew install terminal-notifier` for nicer click handling)"
				}`,
			);
			lines.push("sounds:");
			for (const k of NOTIFY_TYPES) {
				const v = runtimeConfig.sounds[k];
				const path = resolveSoundPath(v);
				lines.push(`  ${k.padEnd(11)} ${v}${path ? "" : "  (NOT FOUND — falls back to silence)"}`);
			}
			lines.push("lines:");
			for (const k of NOTIFY_TYPES) lines.push(`  ${k.padEnd(11)} ${runtimeConfig.lines[k]}`);
			lines.push("");
			lines.push(`Config:  ${CONFIG_PATH.replace(homedir(), "~")}`);
			lines.push("Render:  /tcc:notify generate [--force]   (writes ~/.tcc/sounds/<type>.aiff|.mp3 + updates config)");
			lines.push("Voices:  /tcc:notify voices               (list available macOS say voices)");
			lines.push("Test:    /tcc:notify test [question|permission|error|done|compact]");
			lines.push("Reload:  /tcc:notify reload");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
