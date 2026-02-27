#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrafanaClient, type Panel } from "./grafana.js";

interface PanelMetadata {
	id: number;
	title: string;
	description: string;
}

interface ParsedArgs {
	command: string;
	options: Record<string, string | string[]>;
}

const VALID_COMMANDS = ["search-dashboards", "list-panels", "render-panel"];

export function parseArgs(argv: string[]): ParsedArgs {
	if (argv.length === 0) {
		throw new Error(
			"Usage: grafana-cli <command> [options]\nCommands: search-dashboards, list-panels, render-panel",
		);
	}

	const command = argv[0] as string;

	if (!VALID_COMMANDS.includes(command)) {
		throw new Error(`Unknown command: ${command}`);
	}

	const options: Record<string, string | string[]> = {};
	let i = 1;
	while (i < argv.length) {
		const arg = argv[i] as string;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const value = argv[i + 1];
			if (value === undefined) {
				throw new Error(`Missing value for ${arg}`);
			}
			if (key === "var") {
				if (!options.var) {
					options.var = [];
				}
				(options.var as string[]).push(value);
			} else {
				options[key] = value;
			}
			i += 2;
		} else {
			i++;
		}
	}

	if (command === "list-panels" && !options.dashboard) {
		throw new Error("--dashboard is required for list-panels");
	}

	if (command === "render-panel") {
		if (!options.dashboard) {
			throw new Error("--dashboard is required for render-panel");
		}
		if (!options.panel) {
			throw new Error("--panel is required for render-panel");
		}
	}

	return { command, options };
}

export function collectPanels(panels: Panel[] | undefined, acc: Panel[]): void {
	if (!panels) return;
	for (const panel of panels) {
		acc.push(panel);
		if (panel.panels) {
			collectPanels(panel.panels, acc);
		}
	}
}

function tokenize(title: string): string[] {
	return title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function fuzzyMatchPanels(
	query: string,
	panels: PanelMetadata[],
): PanelMetadata[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];

	const scored = panels
		.filter((p) => p.title.trim().length > 0)
		.map((panel) => {
			const titleTokens = tokenize(panel.title);
			const titleSet = new Set(titleTokens);
			const hits = queryTokens.filter((t) =>
				[...titleSet].some((tt) => tt.includes(t) || t.includes(tt)),
			).length;
			const score = hits / queryTokens.length;
			return { panel, score };
		})
		.filter(({ score }) => score >= 0.5)
		.sort((a, b) => b.score - a.score);

	return scored.slice(0, 5).map(({ panel }) => panel);
}

export async function main(): Promise<void> {
	const grafanaUrl = process.env.GRAFANA_URL;
	const grafanaApiToken = process.env.GRAFANA_API_TOKEN;

	if (!grafanaUrl || !grafanaApiToken) {
		console.error(
			"Error: GRAFANA_URL and GRAFANA_API_TOKEN environment variables are required",
		);
		process.exit(1);
		return;
	}

	const client = new GrafanaClient(grafanaUrl, grafanaApiToken);
	const { command, options } = parseArgs(process.argv.slice(2));

	switch (command) {
		case "search-dashboards": {
			const dashboards = await client.searchDashboards(
				options.query as string | undefined,
			);
			console.log(JSON.stringify(dashboards, null, 2));
			break;
		}

		case "list-panels": {
			const details = await client.getDashboard(options.dashboard as string);
			const allPanels: Panel[] = [];
			collectPanels(details.dashboard.panels, allPanels);
			const panelList = allPanels
				.filter((p) => typeof p.id === "number")
				.map((p) => ({
					id: p.id,
					title: p.title,
					description: p.description ?? "",
				}));

			if (options.search) {
				const matches = fuzzyMatchPanels(options.search as string, panelList);
				console.log(JSON.stringify(matches, null, 2));
			} else {
				console.log(JSON.stringify(panelList, null, 2));
			}
			break;
		}

		case "render-panel": {
			const dashboardUid = options.dashboard as string;
			const panelId = Number.parseInt(options.panel as string, 10);
			const from = (options.from as string) ?? "now-15m";
			const to = (options.to as string) ?? "now";
			const width = options.width
				? Number.parseInt(options.width as string, 10)
				: undefined;
			const height = options.height
				? Number.parseInt(options.height as string, 10)
				: undefined;
			const outPath = (options.out as string) ?? `./panel-${panelId}.png`;

			const variables: Record<string, string> = {};
			if (options.var) {
				const vars = Array.isArray(options.var) ? options.var : [options.var];
				for (const v of vars) {
					const eqIdx = v.indexOf("=");
					if (eqIdx > 0) {
						variables[v.slice(0, eqIdx)] = v.slice(eqIdx + 1);
					}
				}
			}

			let imageBuffer = await client.renderPanel(dashboardUid, panelId, {
				from,
				to,
				width,
				height,
				variables,
			});

			// Cold cache retry: if image is suspiciously small, wait and retry
			const MIN_IMAGE_SIZE = 15_000;
			if (imageBuffer.length < MIN_IMAGE_SIZE) {
				await new Promise((r) => setTimeout(r, 3000));
				imageBuffer = await client.renderPanel(dashboardUid, panelId, {
					from,
					to,
					width,
					height,
					variables,
				});
			}

			fs.mkdirSync(path.dirname(path.resolve(outPath)), {
				recursive: true,
			});
			fs.writeFileSync(outPath, imageBuffer);
			console.log(outPath);
			break;
		}
	}
}

const currentFile = fileURLToPath(import.meta.url);
const isDirectRun =
	process.argv[1] && path.resolve(process.argv[1]) === currentFile;

if (isDirectRun) {
	main().catch((err) => {
		console.error((err as Error).message);
		process.exit(1);
	});
}
