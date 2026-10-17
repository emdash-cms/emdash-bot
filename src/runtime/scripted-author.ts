// A deterministic author for delivery and recovery tests. It is a pi-ai
// provider whose responses are computed from the transcript alone, so it
// behaves identically after an abrupt reset: Pi replays the conversation and
// the script picks up at the same step.
//
// The script lives in the issue body (or a maintainer direction):
//
//   ```scripted-author
//   { "rounds": [ { "steps": [ { "tool": "write", "args": { "path": "a.txt", "content": "x\n" } },
//                              { "tool": "submit_candidate", "args": { "title": "Fix", "summary": "..." } } ],
//                   "final": "Submitted." } ] }
//   ```
//
// A step `{ "tool": "model_error", "args": { "message": "..." } }` fails the model call.
//
// Only non-production profiles register this provider.

import type { JsonObject } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

export const SCRIPTED_PROVIDER = "scripted";
export const SCRIPTED_MODEL = "author";

interface ScriptStep {
	readonly tool: string;
	readonly args: JsonObject;
}

interface Script {
	readonly rounds: ReadonlyArray<{
		readonly steps: readonly ScriptStep[];
		readonly final?: string;
	}>;
}

const BLOCK = /```scripted-author\s*\n([\s\S]*?)\n```/g;

function messageText(message: Message): string {
	const sections =
		message.role === "system"
			? Object.values(message.sections ?? {})
					.filter(Boolean)
					.join("\n")
			: "";
	const content =
		typeof message.content === "string"
			? message.content
			: message.content
					.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
					.join("\n");
	return `${content}\n${sections}`;
}

export function nextScriptedResponse(messages: readonly Message[]) {
	// Each human-originated message starts a script round; the bot's own
	// milestone notices (publication, readiness) do not.
	const milestone = /^## (Published|Ready for human review)\b/;
	const users = messages.flatMap((m, i) =>
		m.role === "user" && !milestone.test(messageText(m).trimStart()) ? [i] : [],
	);
	let script: Script | undefined;
	// The script may sit in a message or in the case record's system section;
	// the last one wins, so a reviewer's brief can carry its own after the request's.
	for (const message of messages) {
		const match = [...messageText(message).matchAll(BLOCK)].at(-1);
		if (match) script = JSON.parse(match[1]!) as Script;
	}
	if (!script) return fauxAssistantMessage("No scripted-author block was provided; nothing to do.");
	// Each case round adds exactly one user message.
	const round = users.length - 1;
	const plan = script.rounds[Math.min(round, script.rounds.length - 1)];
	if (!plan || round >= script.rounds.length)
		return fauxAssistantMessage("The script has no further rounds.");
	const lastUser = users.at(-1)!;
	const step = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
	const next = plan.steps[step];
	if (!next) return fauxAssistantMessage(plan.final ?? "Done.");
	// A failed model call, as a provider reports one after its retries.
	if (next.tool === "model_error")
		return fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage:
				typeof next.args.message === "string" ? next.args.message : "scripted model error",
		});
	return fauxAssistantMessage(
		[
			fauxText(`Step ${step + 1}: ${next.tool}`),
			fauxToolCall(next.tool, next.args, { id: `call-r${round}-s${step}` }),
		],
		{
			stopReason: "toolUse",
		},
	);
}

export function scriptedProvider() {
	const handle = fauxProvider({
		provider: SCRIPTED_PROVIDER,
		models: [{ id: SCRIPTED_MODEL, contextWindow: 200_000, maxTokens: 8192 }],
		tokensPerSecond: 0,
	});
	const respond = (context: { messages: Message[] }) => nextScriptedResponse(context.messages);
	// The faux provider consumes one queued step per request; keep a factory queued.
	const refill = () => handle.setResponses(Array.from({ length: 64 }, () => respond));
	refill();
	return {
		provider: handle.provider,
		refill: () => {
			if (handle.getPendingResponseCount() < 16) refill();
		},
	};
}
