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

const BLOCK = /```scripted-author\s*\n([\s\S]*?)\n```/;

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
		.join("\n");
}

export function nextScriptedResponse(messages: readonly Message[]) {
	const users = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
	let script: Script | undefined;
	for (const index of users) {
		const match = BLOCK.exec(messageText(messages[index]!));
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
