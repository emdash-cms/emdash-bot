// Model wiring. Real models go through the Workers AI binding (Workers AI
// catalog, or vendor models via AI Gateway). The scripted author is
// registered only outside production.

import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { createAI } from "agents/models/pi-ai";
import { type BotConfig, parseModelRef } from "../config.ts";
import { scriptedProvider } from "./scripted-author.ts";

export interface ModelSetup {
	readonly models: MutableModels;
	readonly defaultModel: { provider: string; id: string };
	/** Keep the scripted provider's response queue topped up. */
	readonly beforeRequest: () => void;
}

/** AI Gateway credentials, as Worker secrets. */
export interface GatewaySecrets {
	readonly AI_GATEWAY_TOKEN?: string;
	readonly AI_GATEWAY_ACCOUNT_ID?: string;
	readonly AI_GATEWAY_NAME?: string;
}

type CredentialStore = NonNullable<NonNullable<Parameters<typeof createModels>[0]>["credentials"]>;

/** Serves the gateway credential from secrets; nothing is stored or refreshed. */
function gatewayCredentials(env: GatewaySecrets): CredentialStore | undefined {
	const key = env.AI_GATEWAY_TOKEN;
	const accountId = env.AI_GATEWAY_ACCOUNT_ID;
	const gatewayId = env.AI_GATEWAY_NAME;
	if (!key || !accountId || !gatewayId) return undefined;
	const credential = {
		type: "api_key" as const,
		key,
		env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
	};
	const read = async (providerId: string) =>
		providerId === "cloudflare-ai-gateway" ? credential : undefined;
	return {
		read,
		list: async () => [{ providerId: "cloudflare-ai-gateway", type: "api_key" as const }],
		modify: async (providerId, fn) => fn(await read(providerId)),
		delete: async () => {},
	};
}

export function setupModels(env: { AI?: Ai } & GatewaySecrets, config: BotConfig): ModelSetup {
	const credentials = gatewayCredentials(env);
	const models = createModels(credentials ? { credentials } : undefined);
	// Vendor and Workers AI models over AI Gateway's HTTP API, with the gateway's own token:
	// refs look like `cloudflare-ai-gateway:gpt-5.6-luna`.
	if (credentials) models.setProvider(cloudflareAIGatewayProvider());
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
