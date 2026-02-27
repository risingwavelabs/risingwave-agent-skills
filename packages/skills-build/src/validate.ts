import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";
import matter from "gray-matter";

interface ValidationError {
	file: string;
	errors: string[];
}

async function validateSkill(skillPath: string): Promise<ValidationError[]> {
	const errors: ValidationError[] = [];

	// Check SKILL.md exists
	const skillMdPath = path.join(skillPath, "SKILL.md");
	if (!fs.existsSync(skillMdPath)) {
		errors.push({
			file: skillMdPath,
			errors: ["SKILL.md is required but not found"],
		});
	} else {
		const skillErrors = validateSkillMd(skillMdPath);
		if (skillErrors.length > 0) {
			errors.push({ file: skillMdPath, errors: skillErrors });
		}
	}

	// Check _sections.md exists
	const sectionsPath = path.join(skillPath, "_sections.md");
	if (!fs.existsSync(sectionsPath)) {
		errors.push({
			file: sectionsPath,
			errors: ["_sections.md is required but not found"],
		});
	}

	// Validate reference files
	const referencesDir = path.join(skillPath, "references");
	if (fs.existsSync(referencesDir)) {
		const referenceFiles = await glob("*.md", {
			cwd: referencesDir,
			ignore: ["_*.md"],
		});

		for (const refFile of referenceFiles) {
			const refPath = path.join(referencesDir, refFile);
			const refErrors = validateReference(refPath);
			if (refErrors.length > 0) {
				errors.push({ file: refPath, errors: refErrors });
			}
		}
	}

	return errors;
}

function validateSkillMd(filePath: string): string[] {
	const errors: string[] = [];
	const content = fs.readFileSync(filePath, "utf-8");
	const { data } = matter(content);

	const requiredFields = ["name", "license", "description"];
	for (const field of requiredFields) {
		if (!data[field]) {
			errors.push(`Missing required field: ${field}`);
		}
	}

	const requiredMetadataFields = ["version", "author"];
	if (!data.metadata || typeof data.metadata !== "object") {
		errors.push(
			"Missing required field: metadata (must contain version and author)",
		);
	} else {
		for (const field of requiredMetadataFields) {
			if (!data.metadata[field]) {
				errors.push(`Missing required metadata field: ${field}`);
			}
		}
	}

	return errors;
}

function validateReference(filePath: string): string[] {
	const errors: string[] = [];
	const content = fs.readFileSync(filePath, "utf-8");
	const { data, content: body } = matter(content);

	// Check required frontmatter
	const requiredFields = ["title", "impact", "impactDescription", "tags"];
	for (const field of requiredFields) {
		if (!data[field]) {
			errors.push(`Missing required frontmatter: ${field}`);
		}
	}

	// Check tags is an array
	if (data.tags && !Array.isArray(data.tags)) {
		errors.push("tags must be an array");
	}

	// Check content has required sections
	if (!body.includes("## Problem Statement")) {
		errors.push("Missing '## Problem Statement' section");
	}

	// Note: "## Incorrect Example" / "## Anti-Pattern" and "## Correct Example" / "## Best Practice"
	// sections are recommended but not required. Troubleshooting guides and diagnostic references
	// may use different section structures that are equally valid.

	return errors;
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
		console.log("No skills found to validate");
		return;
	}

	let hasErrors = false;

	for (const skillDir of skillDirs) {
		const skillPath = path.join(skillsDir, skillDir);
		console.log(`Validating ${skillDir}...`);

		const errors = await validateSkill(skillPath);
		if (errors.length > 0) {
			hasErrors = true;
			for (const error of errors) {
				console.error(`\n${error.file}:`);
				for (const e of error.errors) {
					console.error(`  - ${e}`);
				}
			}
		} else {
			console.log(`  ✓ ${skillDir} is valid`);
		}
	}

	if (hasErrors) {
		console.error("\nValidation failed!");
		process.exit(1);
	}

	console.log("\nAll skills are valid!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
