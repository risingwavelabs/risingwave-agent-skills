import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Repository Structure", () => {
	it("should have package.json", () => {
		expect(fs.existsSync("package.json")).toBe(true);
	});

	it("should have .claude-plugin/marketplace.json", () => {
		expect(fs.existsSync(".claude-plugin/marketplace.json")).toBe(true);
	});

	it("should have valid marketplace.json", () => {
		const content = fs.readFileSync(".claude-plugin/marketplace.json", "utf-8");
		const json = JSON.parse(content);

		expect(json.name).toBeDefined();
		expect(json.version).toBeDefined();
		expect(json.plugins).toBeDefined();
		expect(Array.isArray(json.plugins)).toBe(true);
	});

	it("should have skills directory", () => {
		expect(fs.existsSync("skills")).toBe(true);
	});

	it("should have skill template", () => {
		expect(fs.existsSync("skills/_template/SKILL.md")).toBe(true);
		expect(fs.existsSync("skills/_template/_sections.md")).toBe(true);
		expect(fs.existsSync("skills/_template/references/_template.md")).toBe(
			true,
		);
	});
});

describe("Build Tooling", () => {
	it("should have build package", () => {
		expect(fs.existsSync("packages/skills-build/package.json")).toBe(true);
	});

	it("should have build source files", () => {
		expect(fs.existsSync("packages/skills-build/src/index.ts")).toBe(true);
		expect(fs.existsSync("packages/skills-build/src/validate.ts")).toBe(true);
	});
});
