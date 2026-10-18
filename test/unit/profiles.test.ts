import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { readConfig, repositoryFor } from "../../src/config.ts";

const load = (name: string) => JSON.parse(readFileSync(`profiles/${name}.json`, "utf8"));

describe("production profile", () => {
	const config = readConfig({ BOT_CONFIG: load("production") });

	it("loads and admits only emdash-cms/emdash", () => {
		expect(config.profile).toBe("production");
		expect(repositoryFor(config, 1198246700, "emdash-cms/emdash")).toBeDefined();
		expect(repositoryFor(config, 1, "emdash-cms/emdash-bot-pi-fixture")).toBeUndefined();
		expect(config.repositoryPattern).toBeFalsy();
	});

	it("takes on new issues by auto-intake and requires the ruleset's checks", () => {
		expect(config.autoIntake).toBe(true);
		expect(config.checks.required).toEqual(
			expect.arrayContaining(["Typecheck", "Tests", "Browser Tests", "Format"]),
		);
		expect(config.authorModel).not.toMatch(/^scripted:/);
		expect(config.maxActiveAuthors).toBe(4);
		expect(config.intakeLabel).toBe("bot:fix");
	});
});

describe("staging profile", () => {
	it("reviews with a different model family from the author", () => {
		const config = readConfig({ BOT_CONFIG: load("staging") });
		expect(config.reviewModel).toMatch(/claude/);
		expect(config.authorModel).not.toMatch(/claude/);
	});

	it("never admits the production repository", () => {
		const config = readConfig({ BOT_CONFIG: load("staging") });
		expect(repositoryFor(config, 1198246700, "emdash-cms/emdash")).toBeUndefined();
	});
});
