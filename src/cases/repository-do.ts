// Repository-scoped routing: a durable delivery inbox and the aliases that
// map issue/PR numbers and branches to cases. Deterministic; no model work.
// A delivery is recorded before it is acknowledged, and forwarding to the
// case is retried with the same delivery ID until the case accepts it.

import { DurableObject } from "cloudflare:workers";
import { readConfig } from "../config.ts";
import { writeToken } from "../github/auth.ts";
import { GitHubClient } from "../github/client.ts";
import type { NormalizedDelivery } from "../github/webhook.ts";
import type { CaseDelivery } from "./case-do.ts";
import { cases } from "../bindings.ts";

export interface AdmitResult {
	readonly status: "forwarded" | "pending" | "unrouted" | "rejected";
	readonly caseId: string | null;
	readonly duplicate: boolean;
}

export class RepositoryDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS deliveries (delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, delivery TEXT NOT NULL, case_id TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, received_at INTEGER NOT NULL, forwarded_at INTEGER)`,
		);
		ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS deliveries_by_status_age ON deliveries (status, received_at)`,
		);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS author_slots (case_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
		);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, case_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
		);
		// A case whose object keeps failing (a platform storage error, say). Its
		// deliveries stop retrying, people are told once, and a new intake for the
		// same issue or PR starts a fresh case instead of reaching the broken one.
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS unavailable_cases (case_id TEXT PRIMARY KEY, repo TEXT, number INTEGER, error TEXT NOT NULL, since INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0)`,
		);
	}

	#config() {
		return readConfig(this.env);
	}

	#unavailable(caseId: string): boolean {
		return (
			this.ctx.storage.sql
				.exec(`SELECT 1 FROM unavailable_cases WHERE case_id = ?`, caseId)
				.toArray().length > 0
		);
	}

	/** The next case id for an issue or PR whose earlier cases are unavailable. */
	#freshCaseId(base: string): string {
		for (let n = 2; ; n++) {
			const candidate = `${base}-r${n}`;
			if (!this.#unavailable(candidate)) return candidate;
		}
	}

	#resolve(aliases: readonly string[]): string | null {
		for (const alias of aliases) {
			const row = this.ctx.storage.sql
				.exec(`SELECT case_id FROM aliases WHERE alias = ?`, alias)
				.toArray()[0];
			if (row) return row.case_id as string;
		}
		return null;
	}

	async registerAlias(alias: string, caseId: string): Promise<void> {
		this.ctx.storage.sql.exec(
			`INSERT INTO aliases (alias, case_id, created_at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET case_id = excluded.case_id`,
			alias,
			caseId,
			Date.now(),
		);
	}

	async admit(
		deliveryId: string,
		eventName: string,
		normalized: NormalizedDelivery,
		repo?: string,
	): Promise<AdmitResult> {
		if (repo) await this.ctx.storage.put("repo", repo);
		await this.#pruneDeliveries();
		const existing = this.ctx.storage.sql
			.exec(`SELECT case_id, status FROM deliveries WHERE delivery_id = ?`, deliveryId)
			.toArray()[0];
		if (existing) {
			if (existing.status === "pending") await this.#forward(deliveryId);
			const row = this.ctx.storage.sql
				.exec(`SELECT case_id, status FROM deliveries WHERE delivery_id = ?`, deliveryId)
				.toArray()[0]!;
			return {
				status: row.status as AdmitResult["status"],
				caseId: (row.case_id as string | null) ?? null,
				duplicate: true,
			};
		}
		let caseId: string | null;
		if ("create" in normalized.route) {
			const identity = normalized.route.create;
			caseId =
				this.#resolve([
					identity.kind === "issue"
						? `number:${identity.issueNumber}`
						: `number:${identity.prNumber}`,
				]) ?? identity.caseId;
			// A new intake for an issue whose case is unavailable starts over.
			if (this.#unavailable(caseId)) caseId = this.#freshCaseId(identity.caseId);
			// Register aliases before any publication so early webhooks route here.
			this.ctx.storage.transactionSync(() => {
				void this.registerAlias(`number:${identity.issueNumber ?? identity.prNumber}`, caseId!);
				void this.registerAlias(`branch:${identity.branch}`, caseId!);
			});
		} else {
			caseId = this.#resolve(normalized.route.aliases);
		}
		const delivery: CaseDelivery = {
			deliveryId,
			caseId: caseId ?? "",
			kind: normalized.kind,
			actor: normalized.actor,
			provenance: normalized.provenance,
			payload: normalized.payload,
			...("create" in normalized.route
				? { identity: { ...normalized.route.create, caseId: caseId! } }
				: {}),
		};
		this.ctx.storage.sql.exec(
			`INSERT INTO deliveries (delivery_id, event, delivery, case_id, status, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
			deliveryId,
			eventName,
			JSON.stringify(delivery),
			caseId,
			caseId ? "pending" : "unrouted",
			Date.now(),
		);
		if (!caseId) return { status: "unrouted", caseId: null, duplicate: false };
		await this.#forward(deliveryId);
		const row = this.ctx.storage.sql
			.exec(`SELECT status FROM deliveries WHERE delivery_id = ?`, deliveryId)
			.toArray()[0]!;
		return { status: row.status as AdmitResult["status"], caseId, duplicate: false };
	}

	async #forward(deliveryId: string): Promise<void> {
		const row = this.ctx.storage.sql
			.exec(`SELECT * FROM deliveries WHERE delivery_id = ?`, deliveryId)
			.toArray()[0];
		if (!row || row.status !== "pending") return;
		const delivery = JSON.parse(row.delivery as string) as CaseDelivery;
		if (this.#unavailable(delivery.caseId)) {
			this.ctx.storage.sql.exec(
				`UPDATE deliveries SET status = 'failed', error = 'case unavailable' WHERE delivery_id = ?`,
				deliveryId,
			);
			return;
		}
		try {
			const result = await cases(this.env).getByName(delivery.caseId).deliver(delivery);
			this.ctx.storage.sql.exec(
				`UPDATE deliveries SET status = ?, forwarded_at = ?, attempts = attempts + 1, error = NULL WHERE delivery_id = ?`,
				result.accepted ? "forwarded" : "rejected",
				Date.now(),
				deliveryId,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.storage.sql.exec(
				`UPDATE deliveries SET attempts = attempts + 1, error = ? WHERE delivery_id = ?`,
				message,
				deliveryId,
			);
			const attempts = Number(row.attempts) + 1;
			if (attempts >= this.#config().unavailableAfterAttempts) {
				this.ctx.storage.sql.exec(
					`UPDATE deliveries SET status = 'failed' WHERE delivery_id = ?`,
					deliveryId,
				);
				await this.#markUnavailable(delivery.caseId, message);
				return;
			}
			const alarm = await this.ctx.storage.getAlarm();
			if (alarm === null)
				await this.ctx.storage.setAlarm(Date.now() + this.#config().deliveryRetryMs);
		}
	}

	async #markUnavailable(caseId: string, error: string): Promise<void> {
		const alias = this.ctx.storage.sql
			.exec(`SELECT alias FROM aliases WHERE case_id = ? AND alias LIKE 'number:%' LIMIT 1`, caseId)
			.toArray()[0];
		const number =
			typeof alias?.alias === "string" ? Number(alias.alias.slice("number:".length)) : null;
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO unavailable_cases (case_id, repo, number, error, since) VALUES (?, ?, ?, ?, ?)`,
			caseId,
			(await this.ctx.storage.get<string>("repo")) ?? null,
			number,
			error.slice(0, 1000),
			Date.now(),
		);
		await this.#notifyUnavailable();
	}

	/** Tell people on the issue or PR, once per case; retried by the alarm until it succeeds. */
	async #notifyUnavailable(): Promise<void> {
		const config = this.#config();
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT * FROM unavailable_cases WHERE notified = 0 AND number IS NOT NULL AND repo IS NOT NULL`,
			)
			.toArray() as unknown as Array<{
			case_id: string;
			repo: string;
			number: number;
			error: string;
		}>;
		for (const row of rows) {
			try {
				const github = new GitHubClient(
					config.githubApiUrl,
					() => writeToken(this.env, config),
					row.repo,
				);
				await github.request("POST", github.repoPath(`/issues/${row.number}/comments`), {
					body: `The EmDash bot can't continue here: its stored record for this case is unavailable.\n\n> ${row.error.split("\n")[0]}\n\nNothing more will happen on this case. A maintainer can start again by removing and re-applying the \`${config.intakeLabel}\` label; the new attempt starts from the issue as written.\n\n<!-- emdash-bot:unavailable case=${row.case_id} -->`,
				});
				this.ctx.storage.sql.exec(
					`UPDATE unavailable_cases SET notified = 1 WHERE case_id = ?`,
					row.case_id,
				);
			} catch {
				const alarm = await this.ctx.storage.getAlarm();
				if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + config.deliveryRetryMs);
			}
		}
	}

	/**
	 * Drop old deliveries, at most once per `pruneEveryMs`. Unrouted ones (mostly CI check
	 * runs for pull requests the bot does not own) are kept a day; the rest a
	 * month, which covers GitHub redelivery. Pending deliveries are never dropped.
	 */
	async #pruneDeliveries(): Promise<void> {
		const now = Date.now();
		const { unroutedMs, routedMs, pruneEveryMs } = this.#config().deliveryRetention;
		const last = (await this.ctx.storage.get<number>("lastPrune")) ?? 0;
		if (now - last < pruneEveryMs) return;
		await this.ctx.storage.put("lastPrune", now);
		const unrouted = this.ctx.storage.sql.exec(
			`DELETE FROM deliveries WHERE status = 'unrouted' AND received_at < ?`,
			now - unroutedMs,
		).rowsWritten;
		const routed = this.ctx.storage.sql.exec(
			`DELETE FROM deliveries WHERE status IN ('forwarded', 'rejected', 'failed') AND received_at < ?`,
			now - routedMs,
		).rowsWritten;
		if (unrouted + routed > 0)
			console.log(JSON.stringify({ event: "deliveries.pruned", unrouted, routed }));
	}

	async unavailableCases(): Promise<Array<Record<string, unknown>>> {
		return this.ctx.storage.sql.exec(`SELECT * FROM unavailable_cases ORDER BY since`).toArray();
	}

	override async alarm(): Promise<void> {
		const pending = this.ctx.storage.sql
			.exec(
				`SELECT delivery_id FROM deliveries WHERE status = 'pending' ORDER BY received_at LIMIT 50`,
			)
			.toArray();
		for (const row of pending) await this.#forward(row.delivery_id as string);
		await this.#notifyUnavailable();
		const left = this.ctx.storage.sql
			.exec(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'`)
			.toArray()[0]!.n as number;
		if (left > 0) await this.ctx.storage.setAlarm(Date.now() + this.#config().deliveryRetryMs);
	}

	/** Lease one of `limit` author slots to a case. Expired leases are reclaimed. */
	async acquireAuthorSlot(
		caseId: string,
		limit: number,
		ttlMs: number,
	): Promise<{ granted: boolean; holders: string[] }> {
		const now = Date.now();
		this.ctx.storage.sql.exec(`DELETE FROM author_slots WHERE expires_at < ?`, now);
		const holders = this.ctx.storage.sql
			.exec(`SELECT case_id FROM author_slots`)
			.toArray()
			.map((r) => r.case_id as string);
		if (holders.includes(caseId) || holders.length < limit) {
			this.ctx.storage.sql.exec(
				`INSERT INTO author_slots (case_id, expires_at) VALUES (?, ?) ON CONFLICT(case_id) DO UPDATE SET expires_at = excluded.expires_at`,
				caseId,
				now + ttlMs,
			);
			return { granted: true, holders: [...new Set([...holders, caseId])] };
		}
		return { granted: false, holders };
	}

	/** The case an alias (e.g. `number:12`) routes to, if any. */
	async caseFor(alias: string): Promise<string | null> {
		return this.#resolve([alias]);
	}

	async releaseAuthorSlot(caseId: string): Promise<void> {
		this.ctx.storage.sql.exec(`DELETE FROM author_slots WHERE case_id = ?`, caseId);
	}

	async deliveries(limit = 100): Promise<Array<Record<string, unknown>>> {
		return this.ctx.storage.sql
			.exec(
				`SELECT delivery_id, event, case_id, status, attempts, error, received_at, forwarded_at FROM deliveries ORDER BY received_at DESC LIMIT ?`,
				limit,
			)
			.toArray();
	}

	async aliases(): Promise<Array<Record<string, unknown>>> {
		return this.ctx.storage.sql.exec(`SELECT * FROM aliases ORDER BY created_at`).toArray();
	}
}
