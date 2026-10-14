// Repository-scoped routing: a durable delivery inbox and the aliases that
// map issue/PR numbers and branches to cases. Deterministic; no model work.
// A delivery is recorded before it is acknowledged, and forwarding to the
// case is retried with the same delivery ID until the case accepts it.

import { DurableObject } from "cloudflare:workers";
import type { NormalizedDelivery } from "../github/webhook.ts";
import type { CaseDelivery } from "./case-do.ts";
import { cases } from "../bindings.ts";

const RETRY_MS = 15_000;

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
			`CREATE TABLE IF NOT EXISTS author_slots (case_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
		);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, case_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
		);
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
	): Promise<AdmitResult> {
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
		try {
			const result = await cases(this.env).getByName(delivery.caseId).deliver(delivery);
			this.ctx.storage.sql.exec(
				`UPDATE deliveries SET status = ?, forwarded_at = ?, attempts = attempts + 1, error = NULL WHERE delivery_id = ?`,
				result.accepted ? "forwarded" : "rejected",
				Date.now(),
				deliveryId,
			);
		} catch (error) {
			this.ctx.storage.sql.exec(
				`UPDATE deliveries SET attempts = attempts + 1, error = ? WHERE delivery_id = ?`,
				error instanceof Error ? error.message : String(error),
				deliveryId,
			);
			const alarm = await this.ctx.storage.getAlarm();
			if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
		}
	}

	override async alarm(): Promise<void> {
		const pending = this.ctx.storage.sql
			.exec(
				`SELECT delivery_id FROM deliveries WHERE status = 'pending' ORDER BY received_at LIMIT 50`,
			)
			.toArray();
		for (const row of pending) await this.#forward(row.delivery_id as string);
		const left = this.ctx.storage.sql
			.exec(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'`)
			.toArray()[0]!.n as number;
		if (left > 0) await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
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
