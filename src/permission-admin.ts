import { join } from "node:path";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { userConfigDir } from "./config.ts";
import { defaultRuleSummaries } from "./permissions.ts";
import { readJson, writeJsonAtomic } from "./util.ts";

const CONFIG_PATH = join(userConfigDir(), "permissions.json");

interface PermissionsFile {
	rules?: unknown[];
	defaults?: boolean;
	disabledDefaults?: string[];
}

function readFile(): PermissionsFile {
	return readJson<PermissionsFile>(CONFIG_PATH) ?? {};
}

function setRuleEnabled(name: string, enabled: boolean): void {
	const cfg = readFile();
	const disabled = new Set(cfg.disabledDefaults ?? []);
	if (enabled) disabled.delete(name);
	else disabled.add(name);
	cfg.disabledDefaults = [...disabled];
	if (cfg.disabledDefaults.length === 0) delete cfg.disabledDefaults;
	writeJsonAtomic(CONFIG_PATH, cfg);
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/tcc:permission: no UI (headless). Use list / enable <name> / disable <name>.", "error");
		return;
	}
	const cfg = readFile();
	const disabled = new Set(cfg.disabledDefaults ?? []);
	const rules = defaultRuleSummaries();
	const items = rules.map((r) => ({
		id: r.name,
		label: `${r.name}  [${r.action}]`,
		description: r.message || "(no message)",
		currentValue: disabled.has(r.name) ? "disabled" : "enabled",
		values: ["enabled", "disabled"],
	}));

	const pending = new Map<string, boolean>();
	await ctx.ui.custom<void>((_tui, _theme, _kb, done) => {
		return new SettingsList(
			items,
			Math.min(items.length, 15),
			getSettingsListTheme(),
			(id, newValue) => { pending.set(id, newValue === "enabled"); },
			() => done(undefined),
		);
	});

	if (pending.size === 0) {
		ctx.ui.notify("no permission changes", "info");
		return;
	}
	const enabled: string[] = [];
	const disabledNow: string[] = [];
	for (const [name, want] of pending) {
		const before = !disabled.has(name);
		if (want === before) continue;
		setRuleEnabled(name, want);
		(want ? enabled : disabledNow).push(name);
	}
	if (enabled.length === 0 && disabledNow.length === 0) {
		ctx.ui.notify("no net permission changes", "info");
		return;
	}
	const parts: string[] = [];
	if (enabled.length > 0) parts.push(`enabled: ${enabled.join(", ")}`);
	if (disabledNow.length > 0) parts.push(`disabled: ${disabledNow.join(", ")}`);
	ctx.ui.notify(`${parts.join("; ")}. Takes effect on the next session_start (rules are re-read per cwd).`, "info");
}

export default function permissionAdminExtension(pi: ExtensionAPI): void {
	pi.registerCommand("tcc:permission", {
		description: "Toggle built-in permission rules (block/confirm/warn defaults) via interactive checklist. Subcommands: list / enable <name> / disable <name>.",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (!sub) {
				await openPicker(ctx);
				return;
			}

			if (sub === "list") {
				const cfg = readFile();
				const disabled = new Set(cfg.disabledDefaults ?? []);
				const rules = defaultRuleSummaries();
				const nameWidth = Math.max(...rules.map((r) => r.name.length));
				const lines = ["built-in permission rules (toggle with bare `/tcc:permission`):", ""];
				for (const r of rules) {
					const flag = disabled.has(r.name) ? "  DISABLED" : "  enabled ";
					lines.push(`${flag}  ${r.name.padEnd(nameWidth)}  [${r.action}]  ${r.message ?? ""}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "enable" || sub === "disable") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify(`/tcc:permission ${sub}: missing rule name (run /tcc:permission list to see them)`, "error");
					return;
				}
				const rules = defaultRuleSummaries();
				if (!rules.some((r) => r.name === name)) {
					ctx.ui.notify(`/tcc:permission ${sub}: no default rule named '${name}'`, "error");
					return;
				}
				setRuleEnabled(name, sub === "enable");
				ctx.ui.notify(`${sub}d '${name}'. Takes effect on next session_start.`, "info");
				return;
			}

			ctx.ui.notify(`/tcc:permission: unknown subcommand '${sub}'. Try: (bare) | list | enable <name> | disable <name>`, "error");
		},
	});
}
