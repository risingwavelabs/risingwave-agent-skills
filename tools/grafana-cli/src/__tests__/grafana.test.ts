import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrafanaClient } from "../grafana.js";

type FetchCall = {
	input: RequestInfo | URL;
	init?: RequestInit;
};

type MockResponse = {
	ok: boolean;
	status: number;
	statusText: string;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
	arrayBuffer?: () => Promise<ArrayBuffer>;
};

const makeJsonResponse = (body: unknown, status = 200): MockResponse => ({
	ok: status >= 200 && status < 300,
	status,
	statusText: status === 200 ? "OK" : "Error",
	json: async () => body,
	text: async () => JSON.stringify(body),
});

const makeTextErrorResponse = (
	text: string,
	status = 500,
	statusText = "Error",
): MockResponse => ({
	ok: false,
	status,
	statusText,
	json: async () => ({ message: text }),
	text: async () => text,
});

const makeBinaryResponse = (bytes: number[]): MockResponse => ({
	ok: true,
	status: 200,
	statusText: "OK",
	json: async () => ({}),
	text: async () => "",
	arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

describe("GrafanaClient", () => {
	const baseUrl = "https://grafana.example.com/";
	const apiToken = "test-api-token";
	let fetchCalls: FetchCall[] = [];
	let fetchQueue: MockResponse[] = [];
	let originalFetch: typeof fetch | undefined;

	beforeEach(() => {
		fetchCalls = [];
		fetchQueue = [];
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			fetchCalls.push({ input, init });
			const response = fetchQueue.shift();
			if (!response) {
				throw new Error("No mock response queued");
			}
			return response as unknown as Response;
		}) as typeof fetch;
	});

	afterEach(() => {
		if (originalFetch) {
			globalThis.fetch = originalFetch;
		}
	});

	it("searchDashboards builds the expected search URL", async () => {
		fetchQueue.push(makeJsonResponse([]));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.searchDashboards("cpu");

		expect(fetchCalls.length).toBe(1);
		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/api/search?type=dash-db&query=cpu",
		);
		const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers.Authorization).toBe("Bearer test-api-token");
	});

	it("searchDashboards without query omits query param", async () => {
		fetchQueue.push(makeJsonResponse([]));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.searchDashboards();

		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/api/search?type=dash-db",
		);
	});

	it("getDashboard hits the dashboard UID endpoint", async () => {
		fetchQueue.push(makeJsonResponse({}));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.getDashboard("abc123");

		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/api/dashboards/uid/abc123",
		);
	});

	it("listDatasources fetches the datasources list", async () => {
		fetchQueue.push(makeJsonResponse([]));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.listDatasources();

		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/api/datasources",
		);
	});

	it("renderPanel requests a PNG with all options", async () => {
		fetchQueue.push(makeBinaryResponse([1, 2, 3]));
		const client = new GrafanaClient(baseUrl, apiToken);

		const buffer = await client.renderPanel("dash-1", 7, {
			width: 800,
			height: 400,
			from: "now-6h",
			to: "now",
			timezone: "UTC",
			theme: "light",
		});

		expect([...buffer]).toEqual([1, 2, 3]);
		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/render/d-solo/dash-1?panelId=7&width=800&height=400&from=now-6h&to=now&tz=UTC&theme=light",
		);
	});

	it("renderPanel uses correct defaults", async () => {
		fetchQueue.push(makeBinaryResponse([4]));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.renderPanel("dash-2", 3);

		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/render/d-solo/dash-2?panelId=3&width=1000&height=500&from=now-15m&to=now&tz=browser&theme=dark",
		);
	});

	it("renderPanel appends template variables", async () => {
		fetchQueue.push(makeBinaryResponse([4]));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.renderPanel("dash-2", 3, {
			variables: {
				namespace: "dev",
				datasource: "promxy",
			},
		});

		expect(fetchCalls[0]?.input).toBe(
			"https://grafana.example.com/render/d-solo/dash-2?panelId=3&width=1000&height=500&from=now-15m&to=now&tz=browser&theme=dark&var-namespace=dev&var-datasource=promxy",
		);
	});

	it("throws a useful error on non-ok responses", async () => {
		fetchQueue.push(makeTextErrorResponse("bad", 401, "Unauthorized"));
		const client = new GrafanaClient(baseUrl, apiToken);

		await expect(client.searchDashboards()).rejects.toThrow(/401/);
		await expect(
			(async () => {
				fetchQueue.push(makeTextErrorResponse("bad", 401, "Unauthorized"));
				await client.searchDashboards();
			})(),
		).rejects.toThrow(/Unauthorized/);
	});

	it("all requests include Bearer auth header", async () => {
		fetchQueue.push(makeBinaryResponse([1]));
		const client = new GrafanaClient(baseUrl, apiToken);

		await client.renderPanel("d", 1);

		const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-api-token");
	});
});
