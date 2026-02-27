import { fetchWithRetry } from "./retry.js";

export interface Dashboard {
	id: number;
	uid: string;
	title: string;
	uri: string;
	url: string;
	type: string;
	tags: string[];
	isStarred: boolean;
}

export interface Panel {
	id: number;
	title: string;
	type: string;
	description?: string;
	gridPos?: {
		h: number;
		w: number;
		x: number;
		y: number;
	};
	panels?: Panel[];
}

export interface DashboardDetails {
	dashboard: {
		id: number;
		uid: string;
		title: string;
		panels: Panel[];
	};
	meta: {
		url: string;
		slug: string;
	};
}

export interface Datasource {
	id: number;
	uid: string;
	name: string;
	type: string;
	url?: string;
	access?: string;
	isDefault?: boolean;
}

export class GrafanaClient {
	private baseUrl: string;
	private apiToken: string;

	constructor(baseUrl: string, apiToken: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiToken = apiToken;
	}

	private buildHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiToken}`,
		};
	}

	private async requestJson<T>(
		path: string,
		options: Omit<RequestInit, "body"> & { body?: unknown } = {},
	): Promise<T> {
		const { body, headers, ...rest } = options;
		const url = `${this.baseUrl}${path}`;
		const response = await fetchWithRetry("grafana-api", url, {
			...rest,
			headers: {
				...this.buildHeaders(),
				"Content-Type": "application/json",
				...headers,
			},
			body:
				body === undefined
					? undefined
					: typeof body === "string"
						? body
						: JSON.stringify(body),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Grafana API error: ${response.status} ${response.statusText} - ${text}`,
			);
		}

		if (response.status === 204) {
			return undefined as T;
		}

		return response.json() as Promise<T>;
	}

	private async fetchBinary(path: string): Promise<Buffer> {
		const url = `${this.baseUrl}${path}`;
		const response = await fetchWithRetry("grafana-api", url, {
			headers: {
				...this.buildHeaders(),
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`Grafana API error: ${response.status} ${response.statusText} - ${text}`,
			);
		}

		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	async searchDashboards(query?: string): Promise<Dashboard[]> {
		const searchParams = new URLSearchParams({ type: "dash-db" });
		if (query) {
			searchParams.set("query", query);
		}
		return this.requestJson<Dashboard[]>(
			`/api/search?${searchParams.toString()}`,
		);
	}

	async getDashboard(uid: string): Promise<DashboardDetails> {
		return this.requestJson<DashboardDetails>(`/api/dashboards/uid/${uid}`);
	}

	async listDatasources(): Promise<Datasource[]> {
		return this.requestJson<Datasource[]>("/api/datasources");
	}

	async renderPanel(
		dashboardUid: string,
		panelId: number,
		options: {
			width?: number;
			height?: number;
			from?: string;
			to?: string;
			timezone?: string;
			theme?: "light" | "dark";
			variables?: Record<string, string | number>;
		} = {},
	): Promise<Buffer> {
		const {
			width = 1000,
			height = 500,
			from = "now-15m",
			to = "now",
			timezone = "browser",
			theme = "dark",
			variables,
		} = options;

		const params = new URLSearchParams({
			panelId: panelId.toString(),
			width: width.toString(),
			height: height.toString(),
			from,
			to,
			tz: timezone,
			theme,
		});

		if (variables) {
			for (const [key, value] of Object.entries(variables)) {
				params.append(`var-${key}`, String(value));
			}
		}

		return this.fetchBinary(
			`/render/d-solo/${dashboardUid}?${params.toString()}`,
		);
	}
}
