// Model wiring. Real models go through the Workers AI binding (Workers AI
// catalog, or vendor models via AI Gateway). The scripted author is
// registered only outside production.

import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createAI } from "agents/models/pi-ai";
import { type BotConfig, parseModelRef } from "../config.ts";
import { scriptedProvider } from "./scripted-author.ts";

export interface ModelSetup {
	readonly models: MutableModels;
	readonly defaultModel: { provider: string; id: string };
	/** Keep the scripted provider's response queue topped up. */
	readonly beforeRequest: () => void;
}

export function setupModels(env: { AI?: Ai }, config: BotConfig): ModelSetup {
	const models = createModels();
	let beforeRequest = () => {};
	if (env.AI) {
		const ai = createAI({
			binding: env.AI,
			...(config.gatewayId ? { gateway: config.gatewayId } : {}),
		});
		models.setProvider(ai.provider);
	}
	if (config.profile !== "production") {
		const scripted = scriptedProvider();
		models.setProvider(scripted.provider);
		beforeRequest = scripted.refill;
	}
	const defaultModel = parseModelRef(config.authorModel);
	if (defaultModel.provider === "scripted" && config.profile === "production") {
		throw new Error("the scripted author is not available in production");
	}
	return { models, defaultModel, beforeRequest };
}
