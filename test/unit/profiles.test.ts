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

	it("starts with maintainer-assigned intake only and requires the ruleset's checks", () => {
		expect(config.autoIntake).toBe(false);
		expect(config.checks.required).toEqual(
			expect.arrayContaining(["Typecheck", "Tests", "Browser Tests", "Format"]),
		);
		expect(config.authorModel).not.toMatch(/^scripted:/);
		expect(config.maxActiveAuthors).toBe(2);
		expect(config.intakeLabel).toBe("bot:fix");
	});

	it("lets only plan-gated required lanes skip, guarded by the required Tests job", () => {
		const skippable = Object.keys(config.checks.skippable ?? {});
		expect(skippable).toEqual(["Smoke Tests", "Browser Tests"]);
		for (const name of skippable) expect(config.checks.required).toContain(name);
		expect(config.checks.required).toContain("Tests");
	});
});

describe("staging profile", () => {
	it("never admits the production repository", () => {
		const config = readConfig({ BOT_CONFIG: load("staging") });
		expect(repositoryFor(config, 1198246700, "emdash-cms/emdash")).toBeUndefined();
	});
});
