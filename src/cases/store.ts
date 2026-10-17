// The case record lives in the same SQLite database as Pi's `pi_` tables, so
// a checkpoint pointer, its operation receipt and case state commit together.

import type {
	Candidate,
	CaseEvent,
	CaseIdentity,
	CaseState,
	CheckpointRow,
	Finding,
	FindingStatus,
	Publication,
	Requirement,
	ReviewRecord,
	Verification,
} from "./types.ts";

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS case_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, actor TEXT NOT NULL, provenance TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, consumed_round INTEGER)`,
	`CREATE TABLE IF NOT EXISTS case_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_operations (op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_checkpoints (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, op_id TEXT NOT NULL, base_commit TEXT NOT NULL, tree_hash TEXT NOT NULL, digest TEXT NOT NULL, artifact_key TEXT NOT NULL, size INTEGER NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_candidates (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_publications (op_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_verifications (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_findings (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_reviews (review_id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_requirements (revision INTEGER PRIMARY KEY, data TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS case_faults (boundary TEXT PRIMARY KEY, armed_at INTEGER NOT NULL, attempt TEXT)`,
];

type Row = Record<string, SqlStorageValue>;

export class CaseStore {
	constructor(private readonly storage: DurableObjectStorage) {
		for (const statement of SCHEMA) storage.sql.exec(statement);
	}

	private get sql(): SqlStorage {
		return this.storage.sql;
	}

	transaction<T>(fn: () => T): T {
		return this.storage.transactionSync(fn);
	}

	private rows(query: string, ...bindings: SqlStorageValue[]): Row[] {
		return this.sql.exec(query, ...bindings).toArray() as Row[];
	}

	private one(query: string, ...bindings: SqlStorageValue[]): Row | undefined {
		return this.rows(query, ...bindings)[0];
	}

	// ---- meta ----

	getMeta<T>(key: string): T | undefined {
		const row = this.one(`SELECT value FROM case_meta WHERE key = ?`, key);
		return row ? (JSON.parse(row.value as string) as T) : undefined;
	}

	setMeta(key: string, value: unknown): void {
		this.sql.exec(
			`INSERT INTO case_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			JSON.stringify(value),
		);
	}

	identity(): CaseIdentity | undefined {
		return this.getMeta<CaseIdentity>("identity");
	}

	generation(): number {
		return this.getMeta<number>("generation") ?? 0;
	}

	state(): CaseState | undefined {
		return this.getMeta<CaseState>("state");
	}

	// ---- events ----

	/** Record an accepted delivery once. Returns false for a duplicate. */
	insertEvent(event: Omit<CaseEvent, "seq" | "consumedRound">): boolean {
		const result = this.sql.exec(
			`INSERT INTO case_events (delivery_id, kind, actor, provenance, payload, received_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
			event.deliveryId,
			event.kind,
			event.actor,
			event.provenance,
			JSON.stringify(event.payload),
			event.receivedAt,
		);
		return result.rowsWritten > 0;
	}

	events(): CaseEvent[] {
		return this.rows(`SELECT * FROM case_events ORDER BY seq`).map(eventFromRow);
	}

	pendingEvents(): CaseEvent[] {
		return this.rows(`SELECT * FROM case_events WHERE consumed_round IS NULL ORDER BY seq`).map(
			eventFromRow,
		);
	}

	markConsumed(seqs: readonly number[], round: number): void {
		for (const seq of seqs)
			this.sql.exec(`UPDATE case_events SET consumed_round = ? WHERE seq = ?`, round, seq);
	}

	// ---- log ----

	log(type: string, data: Record<string, unknown> = {}): void {
		this.sql.exec(
			`INSERT INTO case_log (at, type, data) VALUES (?, ?, ?)`,
			Date.now(),
			type,
			JSON.stringify(data),
		);
		console.log(JSON.stringify({ event: type, case: this.identity()?.caseId, ...data }));
	}

	/** The latest entries of the given types, oldest first. */
	logOfTypes(
		types: readonly string[],
		limit: number,
	): Array<{ at: number; type: string; data: Record<string, unknown> }> {
		if (types.length === 0) return [];
		return this.rows(
			`SELECT at, type, data FROM case_log WHERE type IN (${types.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT ?`,
			...types,
			limit,
		)
			.map((r) => ({
				at: r.at as number,
				type: r.type as string,
				data: JSON.parse(r.data as string) as Record<string, unknown>,
			}))
			.reverse();
	}

	lastLogAt(): number | null {
		return (this.rows(`SELECT MAX(at) AS at FROM case_log`)[0]?.at as number | null) ?? null;
	}

	logEntries(): Array<{ seq: number; at: number; type: string; data: Record<string, unknown> }> {
		return this.rows(`SELECT * FROM case_log ORDER BY seq`).map((r) => ({
			seq: r.seq as number,
			at: r.at as number,
			type: r.type as string,
			data: JSON.parse(r.data as string) as Record<string, unknown>,
		}));
	}

	// ---- operation receipts ----

	operation(
		opId: string,
	): { kind: string; generation: number; status: string; result: unknown } | undefined {
		const row = this.one(`SELECT * FROM case_operations WHERE op_id = ?`, opId);
		if (!row) return undefined;
		return {
			kind: row.kind as string,
			generation: row.generation as number,
			status: row.status as string,
			result: row.result === null ? null : JSON.parse(row.result as string),
		};
	}

	putOperation(
		opId: string,
		kind: string,
		generation: number,
		status: string,
		result: unknown,
	): void {
		const at = Date.now();
		this.sql.exec(
			`INSERT INTO case_operations (op_id, kind, generation, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(op_id) DO UPDATE SET status = excluded.status, result = excluded.result, updated_at = excluded.updated_at`,
			opId,
			kind,
			generation,
			status,
			JSON.stringify(result ?? null),
			at,
			at,
		);
	}

	operations(): Array<{
		opId: string;
		kind: string;
		status: string;
		generation: number;
		result: unknown;
	}> {
		return this.rows(`SELECT * FROM case_operations ORDER BY created_at`).map((r) => ({
			opId: r.op_id as string,
			kind: r.kind as string,
			status: r.status as string,
			generation: r.generation as number,
			result: r.result === null ? null : JSON.parse(r.result as string),
		}));
	}

	// ---- checkpoints ----

	latestCheckpoint(): CheckpointRow | undefined {
		const row = this.one(`SELECT * FROM case_checkpoints ORDER BY seq DESC LIMIT 1`);
		return row ? checkpointFromRow(row) : undefined;
	}

	checkpoint(id: string): CheckpointRow | undefined {
		const row = this.one(`SELECT * FROM case_checkpoints WHERE id = ?`, id);
		return row ? checkpointFromRow(row) : undefined;
	}

	checkpoints(): CheckpointRow[] {
		return this.rows(`SELECT * FROM case_checkpoints ORDER BY seq`).map(checkpointFromRow);
	}

	insertCheckpoint(row: Omit<CheckpointRow, "seq">): CheckpointRow {
		const seq =
			((this.one(`SELECT MAX(seq) AS s FROM case_checkpoints`)?.s as number | null) ?? 0) + 1;
		this.sql.exec(
			`INSERT INTO case_checkpoints (id, seq, op_id, base_commit, tree_hash, digest, artifact_key, size, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.id,
			seq,
			row.opId,
			row.baseCommit,
			row.treeHash,
			row.digest,
			row.artifactKey,
			row.size,
			row.generation,
			row.createdAt,
		);
		return { ...row, seq };
	}

	// ---- JSON document tables ----

	private putDoc(
		table: string,
		key: string,
		keyColumn: string,
		data: unknown,
		extra: Record<string, SqlStorageValue> = {},
	): void {
		const columns = [keyColumn, "data", ...Object.keys(extra)];
		const updates = [
			"data = excluded.data",
			...Object.keys(extra).map((c) => `${c} = excluded.${c}`),
		];
		this.sql.exec(
			`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${keyColumn}) DO UPDATE SET ${updates.join(", ")}`,
			key,
			JSON.stringify(data),
			...Object.values(extra),
		);
	}

	private docs<T>(query: string, ...bindings: SqlStorageValue[]): T[] {
		return this.rows(query, ...bindings).map((r) => JSON.parse(r.data as string) as T);
	}

	putCandidate(candidate: Candidate): void {
		if (this.candidate(candidate.id)) throw new Error(`candidate ${candidate.id} is immutable`);
		this.putDoc("case_candidates", candidate.id, "id", candidate, {
			created_at: candidate.createdAt,
		});
	}

	candidate(id: string): Candidate | undefined {
		return this.docs<Candidate>(`SELECT data FROM case_candidates WHERE id = ?`, id)[0];
	}

	candidates(): Candidate[] {
		return this.docs<Candidate>(`SELECT data FROM case_candidates ORDER BY created_at, rowid`);
	}

	latestCandidate(): Candidate | undefined {
		return this.docs<Candidate>(
			`SELECT data FROM case_candidates ORDER BY created_at DESC, rowid DESC LIMIT 1`,
		)[0];
	}

	putPublication(publication: Publication): void {
		this.putDoc("case_publications", publication.opId, "op_id", publication, {
			candidate_id: publication.candidateId,
			updated_at: publication.updatedAt,
		});
	}

	publication(opId: string): Publication | undefined {
		return this.docs<Publication>(`SELECT data FROM case_publications WHERE op_id = ?`, opId)[0];
	}

	publications(): Publication[] {
		return this.docs<Publication>(`SELECT data FROM case_publications ORDER BY rowid`);
	}

	putVerification(verification: Verification): void {
		this.putDoc("case_verifications", verification.id, "id", verification, {
			updated_at: Date.now(),
		});
	}

	verification(id: string): Verification | undefined {
		return this.docs<Verification>(`SELECT data FROM case_verifications WHERE id = ?`, id)[0];
	}

	verifications(): Verification[] {
		return this.docs<Verification>(`SELECT data FROM case_verifications ORDER BY rowid`);
	}

	putFinding(finding: Finding): void {
		this.putDoc("case_findings", finding.id, "id", finding, { updated_at: finding.updatedAt });
	}

	finding(id: string): Finding | undefined {
		return this.docs<Finding>(`SELECT data FROM case_findings WHERE id = ?`, id)[0];
	}

	findings(): Finding[] {
		return this.docs<Finding>(`SELECT data FROM case_findings ORDER BY rowid`);
	}

	updateFinding(
		id: string,
		status: FindingStatus,
		by: string,
		note?: string,
		commit?: string,
	): Finding | undefined {
		const finding = this.finding(id);
		if (!finding) return undefined;
		const at = Date.now();
		const next: Finding = {
			...finding,
			status,
			authorNote: by === "author" ? (note ?? finding.authorNote) : finding.authorNote,
			updatedAt: at,
			history: [
				...finding.history,
				{ at, status, by, ...(note ? { note } : {}), ...(commit ? { commit } : {}) },
			],
		};
		this.putFinding(next);
		return next;
	}

	putReview(review: ReviewRecord): boolean {
		const exists = this.one(
			`SELECT review_id FROM case_reviews WHERE review_id = ?`,
			review.reviewId,
		);
		if (exists) return false;
		this.putDoc("case_reviews", review.reviewId, "review_id", review);
		return true;
	}

	reviews(): ReviewRecord[] {
		return this.docs<ReviewRecord>(`SELECT data FROM case_reviews ORDER BY rowid`);
	}

	addRequirement(requirement: Omit<Requirement, "revision">): Requirement {
		const revision =
			((this.one(`SELECT MAX(revision) AS r FROM case_requirements`)?.r as number | null) ?? 0) + 1;
		const full = { ...requirement, revision };
		this.putDoc("case_requirements", String(revision), "revision", full);
		return full;
	}

	requirements(): Requirement[] {
		return this.docs<Requirement>(`SELECT data FROM case_requirements ORDER BY revision`);
	}

	requirementsRevision(): number {
		return (this.one(`SELECT MAX(revision) AS r FROM case_requirements`)?.r as number | null) ?? 0;
	}

	// ---- faults (non-production profiles only) ----

	armFault(boundary: string, attempt?: string): void {
		this.sql.exec(
			`INSERT OR REPLACE INTO case_faults (boundary, armed_at, attempt) VALUES (?, ?, ?)`,
			boundary,
			Date.now(),
			attempt ?? null,
		);
	}

	/** Disarm and report whether the boundary was armed. */
	takeFault(boundary: string): boolean {
		return this.sql.exec(`DELETE FROM case_faults WHERE boundary = ?`, boundary).rowsWritten > 0;
	}

	hasFault(boundary: string): boolean {
		return this.rows(`SELECT 1 FROM case_faults WHERE boundary = ?`, boundary).length > 0;
	}

	armedFaults(): string[] {
		return this.rows(`SELECT boundary FROM case_faults`).map((r) => r.boundary as string);
	}
}

function eventFromRow(r: Row): CaseEvent {
	return {
		seq: r.seq as number,
		deliveryId: r.delivery_id as string,
		kind: r.kind as string,
		actor: r.actor as string,
		provenance: r.provenance as string,
		payload: JSON.parse(r.payload as string) as Record<string, unknown>,
		receivedAt: r.received_at as number,
		consumedRound: (r.consumed_round as number | null) ?? null,
	};
}

function checkpointFromRow(r: Row): CheckpointRow {
	return {
		id: r.id as string,
		seq: r.seq as number,
		opId: r.op_id as string,
		baseCommit: r.base_commit as string,
		treeHash: r.tree_hash as string,
		digest: r.digest as string,
		artifactKey: r.artifact_key as string,
		size: r.size as number,
		generation: r.generation as number,
		createdAt: r.created_at as number,
	};
}
