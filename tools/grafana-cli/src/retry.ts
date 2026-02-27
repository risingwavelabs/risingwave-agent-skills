const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function isRetryable(err: unknown): boolean {
	const msg = (err as Error)?.message ?? "";
	const cause = (err as { cause?: Error })?.cause?.message ?? "";
	const combined = `${msg} ${cause}`;
	return (
		combined.includes("EAI_AGAIN") ||
		combined.includes("ENOTFOUND") ||
		combined.includes("ETIMEDOUT") ||
		combined.includes("ECONNRESET") ||
		combined.includes("fetch failed")
	);
}

export async function fetchWithRetry(
	tag: string,
	url: string,
	init?: RequestInit,
	options?: { baseDelay?: number },
): Promise<Response> {
	let lastErr: unknown;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await fetch(url, init);
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err)) {
				throw err;
			}
			if (attempt < MAX_RETRIES) {
				const delay = (options?.baseDelay ?? BASE_DELAY_MS) * 2 ** attempt;
				console.error(
					`[${tag}] ${url} failed (attempt ${attempt + 1}): ${(err as Error).message} — retrying in ${delay}ms`,
				);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	throw lastErr;
}
