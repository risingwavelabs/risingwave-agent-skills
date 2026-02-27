import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";
import matter from "gray-matter";

interface ReferenceFrontmatter {
	title: string;
	impact: string;
	impactDescription: string;
	tags: string[];
}

interface Section {
	name: string;
	prefix: string;
	priority: string;
}

async function buildAgentsMd(skillPath: string): Promise<void> {
	const sectionsPath = path.join(skillPath, "_sections.md");
	const referencesDir = path.join(skillPath, "references");
	const outputPath = path.join(skillPath, "AGENTS.md");

	if (!fs.existsSync(sectionsPath)) {
		console.error(`_sections.md not found in ${skillPath}`);
		process.exit(1);
	}

	if (!fs.existsSync(referencesDir)) {
		console.error(`references/ directory not found in ${skillPath}`);
		process.exit(1);
	}

	// Parse sections
	const sectionsContent = fs.readFileSync(sectionsPath, "utf-8");
	const sections = parseSections(sectionsContent);

	// Get all reference files
	const referenceFiles = await glob("*.md", {
		cwd: referencesDir,
		ignore: ["_*.md"],
	});

	// Group references by section
	const groupedRefs = new Map<string, string[]>();
	for (const section of sections) {
		groupedRefs.set(section.prefix, []);
	}

	for (const file of referenceFiles) {
		const prefix = file.split("-")[0];
		if (groupedRefs.has(prefix)) {
			groupedRefs.get(prefix)?.push(file);
		}
	}

	// Build AGENTS.md content
	let output = "# Agent References\n\n";
	output +=
		"> This file is auto-generated. Do not edit directly. Run `npm run build` to regenerate.\n\n";

	for (const section of sections) {
		const refs = groupedRefs.get(section.prefix) || [];
		if (refs.length === 0) continue;

		output += `## ${section.name} (${section.priority})\n\n`;

		for (const refFile of refs.sort()) {
			const refPath = path.join(referencesDir, refFile);
			const refContent = fs.readFileSync(refPath, "utf-8");
			const { data, content } = matter(refContent);
			const frontmatter = data as ReferenceFrontmatter;

			output += `### ${frontmatter.title}\n\n`;
			output += `**Impact:** ${frontmatter.impact} - ${frontmatter.impactDescription}\n\n`;
			output += `**Tags:** ${frontmatter.tags.join(", ")}\n\n`;
			output += `${content.trim()}\n\n`;
			output += "---\n\n";
		}
	}

	fs.writeFileSync(outputPath, output);
	console.log(`Generated ${outputPath}`);
}

function parseSections(content: string): Section[] {
	const sections: Section[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		// Parse lines like: - query- | Query Performance | CRITICAL
		const match = line.match(
			/^-\s+(\w+)-?\s*\|\s*([^|]+)\s*\|\s*(\w+(?:-\w+)?)\s*$/,
		);
		if (match) {
			sections.push({
				prefix: match[1],
				name: match[2].trim(),
				priority: match[3].trim(),
			});
		}
	}

	return sections;
}

async function main(): Promise<void> {
	const skillsDir = path.join(process.cwd(), "skills");

	if (!fs.existsSync(skillsDir)) {
		console.error("skills/ directory not found");
		process.exit(1);
	}

	const skillDirs = fs
		.readdirSync(skillsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith("_"))
		.map((d) => d.name);

	if (skillDirs.length === 0) {
		console.log("No skills found to build");
		return;
	}

	for (const skillDir of skillDirs) {
		const skillPath = path.join(skillsDir, skillDir);
		console.log(`Building ${skillDir}...`);
		await buildAgentsMd(skillPath);
	}

	console.log("Build complete!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
