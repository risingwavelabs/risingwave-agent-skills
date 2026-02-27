import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectPanels, fuzzyMatchPanels, main, parseArgs } from "../cli.js";
import type { Panel } from "../grafana.js";

describe("parseArgs", () => {
	it("parses search-dashboards with no options", () => {
		const result = parseArgs(["search-dashboards"]);
		expect(result.command).toBe("search-dashboards");
		expect(result.options).toEqual({});
	});

	it("parses search-dashboards with --query", () => {
		const result = parseArgs(["search-dashboards", "--query", "cpu"]);
		expect(result.command).toBe("search-dashboards");
		expect(result.options.query).toBe("cpu");
	});

	it("parses list-panels with --dashboard", () => {
		const result = parseArgs(["list-panels", "--dashboard", "abc123"]);
		expect(result.command).toBe("list-panels");
		expect(result.options.dashboard).toBe("abc123");
	});

	it("parses list-panels with --dashboard and --search", () => {
		const result = parseArgs([
			"list-panels",
			"--dashboard",
			"abc123",
			"--search",
			"barrier",
		]);
		expect(result.command).toBe("list-panels");
		expect(result.options.dashboard).toBe("abc123");
		expect(result.options.search).toBe("barrier");
	});

	it("parses render-panel with required options", () => {
		const result = parseArgs([
			"render-panel",
			"--dashboard",
			"abc",
			"--panel",
			"7",
		]);
		expect(result.command).toBe("render-panel");
		expect(result.options.dashboard).toBe("abc");
		expect(result.options.panel).toBe("7");
	});

	it("parses render-panel with all options", () => {
		const result = parseArgs([
			"render-panel",
			"--dashboard",
			"abc",
			"--panel",
			"7",
			"--from",
			"now-1h",
			"--to",
			"now",
			"--width",
			"800",
			"--height",
			"400",
			"--var",
			"namespace=dev",
			"--var",
			"datasource=prom",
			"--out",
			"./test.png",
		]);
		expect(result.command).toBe("render-panel");
		expect(result.options.dashboard).toBe("abc");
		expect(result.options.panel).toBe("7");
		expect(result.options.from).toBe("now-1h");
		expect(result.options.to).toBe("now");
		expect(result.options.width).toBe("800");
		expect(result.options.height).toBe("400");
		expect(result.options.var).toEqual(["namespace=dev", "datasource=prom"]);
		expect(result.options.out).toBe("./test.png");
	});

	it("throws on unknown command", () => {
		expect(() => parseArgs(["unknown-cmd"])).toThrow(/Unknown command/);
	});

	it("throws on missing command", () => {
		expect(() => parseArgs([])).toThrow(/Usage/);
	});

	it("throws on list-panels without --dashboard", () => {
		expect(() => parseArgs(["list-panels"])).toThrow(/--dashboard is required/);
	});

	it("throws on render-panel without --dashboard", () => {
		expect(() => parseArgs(["render-panel", "--panel", "7"])).toThrow(
			/--dashboard is required/,
		);
	});

	it("throws on render-panel without --panel", () => {
		expect(() => parseArgs(["render-panel", "--dashboard", "abc"])).toThrow(
			/--panel is required/,
		);
	});
});

describe("main", () => {
	let originalEnv: NodeJS.ProcessEnv;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
	let exitSpy: any;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.GRAFANA_URL;
		delete process.env.GRAFANA_API_TOKEN;
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		process.env = originalEnv;
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	it("exits with error when env vars are missing", async () => {
		await main();
		expect(errorSpy).toHaveBeenCalledWith(
			"Error: GRAFANA_URL and GRAFANA_API_TOKEN environment variables are required",
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

describe("collectPanels", () => {
	it("flattens nested panels", () => {
		const panels: Panel[] = [
			{
				id: 1,
				title: "Row",
				type: "row",
				panels: [
					{ id: 2, title: "Child A", type: "graph" },
					{ id: 3, title: "Child B", type: "graph" },
				],
			},
			{ id: 4, title: "Top Level", type: "graph" },
		];
		const result: Panel[] = [];
		collectPanels(panels, result);
		expect(result.map((p) => p.id)).toEqual([1, 2, 3, 4]);
	});

	it("handles empty input", () => {
		const result: Panel[] = [];
		collectPanels(undefined, result);
		expect(result).toEqual([]);
	});
});

describe("fuzzyMatchPanels", () => {
	const panels = [
		{ id: 1, title: "Barrier Latency", description: "" },
		{ id: 2, title: "Actor Output Blocking Time Ratio", description: "" },
		{ id: 3, title: "Source Throughput", description: "" },
		{ id: 4, title: "L0 SSTable Count", description: "" },
		{ id: 5, title: "Memory Usage", description: "" },
	];

	it("finds exact token match", () => {
		const result = fuzzyMatchPanels("barrier", panels);
		expect(result[0]?.id).toBe(1);
	});

	it("finds partial match (sst matches sstable)", () => {
		const result = fuzzyMatchPanels("sst count", panels);
		expect(result[0]?.id).toBe(4);
	});

	it("returns empty for no match", () => {
		const result = fuzzyMatchPanels("zzzzz", panels);
		expect(result).toEqual([]);
	});

	it("returns max 5 results", () => {
		const manyPanels = Array.from({ length: 20 }, (_, i) => ({
			id: i,
			title: `Panel metric ${i}`,
			description: "",
		}));
		const result = fuzzyMatchPanels("panel metric", manyPanels);
		expect(result.length).toBeLessThanOrEqual(5);
	});
});
