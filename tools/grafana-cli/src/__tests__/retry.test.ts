import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchWithRetry } from "../retry.js";

describe("fetchWithRetry", () => {
	let originalFetch: typeof fetch | undefined;
	let fetchCalls: number;

	beforeEach(() => {
		fetchCalls = 0;
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (originalFetch) {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns response on first success", async () => {
		globalThis.fetch = (async () => {
			fetchCalls++;
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		const response = await fetchWithRetry("test", "https://example.com");
		expect(response.status).toBe(200);
		expect(fetchCalls).toBe(1);
	});

	it("retries on transient error and succeeds", async () => {
		globalThis.fetch = (async () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				throw new Error("fetch failed: ECONNRESET");
			}
			return new Response("ok", { status: 200 });
		}) as typeof fetch;

		const response = await fetchWithRetry(
			"test",
			"https://example.com",
			undefined,
			{ baseDelay: 0 },
		);
		expect(response.status).toBe(200);
		expect(fetchCalls).toBe(2);
	});

	it("throws immediately on non-retryable error", async () => {
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("Invalid URL");
		}) as typeof fetch;

		await expect(fetchWithRetry("test", "https://example.com")).rejects.toThrow(
			"Invalid URL",
		);
		expect(fetchCalls).toBe(1);
	});

	it("throws after exhausting retries on transient error", async () => {
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("fetch failed: ETIMEDOUT");
		}) as typeof fetch;

		await expect(
			fetchWithRetry("test", "https://example.com", undefined, {
				baseDelay: 0,
			}),
		).rejects.toThrow("ETIMEDOUT");
		expect(fetchCalls).toBe(4); // 1 initial + 3 retries
	});
});
