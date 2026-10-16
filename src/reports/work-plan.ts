// The author's work plan: a short checklist it keeps up to date, shown in the
// bot's single progress comment. The model decides the plan; this module only
// bounds its shape (ported from the previous EmDash bot's update_work_plan).

export const WORK_PLAN_STEP_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"blocked",
	"skipped",
] as const;
export type WorkPlanStepStatus = (typeof WORK_PLAN_STEP_STATUSES)[number];

export interface WorkPlanStep {
	readonly id: string;
	readonly title: string;
	readonly status: WorkPlanStepStatus;
}

export interface WorkPlan {
	readonly summary: string;
	readonly steps: readonly WorkPlanStep[];
	readonly updatedAt: number;
}

const STEP_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_STEPS = 8;

function bounded(value: string, max: number, what: string): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (!text) throw new Error(`${what} is empty`);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function updateWorkPlan(
	previous: WorkPlan | null,
	input: { summary: string; steps: readonly WorkPlanStep[] },
	updatedAt: number,
): WorkPlan {
	const ids = new Set<string>();
	const steps = input.steps.map((step) => {
		const id = step.id.trim();
		if (!STEP_ID.test(id)) throw new Error(`invalid step id: ${id}`);
		if (ids.has(id)) throw new Error("step ids must be unique");
		ids.add(id);
		if (!WORK_PLAN_STEP_STATUSES.includes(step.status))
			throw new Error(`invalid step status: ${step.status}`);
		return { id, title: bounded(step.title, 120, `step ${id}`), status: step.status };
	});
	if (steps.length === 0 || steps.length > MAX_STEPS)
		throw new Error(`a plan has between 1 and ${MAX_STEPS} steps`);
	if (steps.filter((s) => s.status === "in_progress").length > 1)
		throw new Error("at most one step can be in progress");
	for (const prior of previous?.steps ?? []) {
		if (prior.status !== "completed" && prior.status !== "skipped") continue;
		const current = steps.find((s) => s.id === prior.id);
		if (!current) throw new Error(`${prior.status} step ${prior.id} cannot be removed`);
		if (current.status !== prior.status)
			throw new Error(`${prior.status} step ${prior.id} cannot return to ${current.status}`);
	}
	return { summary: bounded(input.summary, 240, "summary"), steps, updatedAt };
}

const MARK: Record<WorkPlanStepStatus, string> = {
	pending: "- [ ]",
	in_progress: "- [ ] **(in progress)**",
	completed: "- [x]",
	blocked: "- [ ] **(blocked)**",
	skipped: "- [x] ~~",
};

function escape(text: string): string {
	return text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

export function renderWorkPlan(plan: WorkPlan): string[] {
	return [
		escape(plan.summary),
		"",
		...plan.steps.map((s) =>
			s.status === "skipped"
				? `${MARK.skipped}${escape(s.title)}~~`
				: `${MARK[s.status]} ${escape(s.title)}`,
		),
	];
}
