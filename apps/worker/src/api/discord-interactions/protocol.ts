import type { RESTPatchAPIInteractionOriginalResponseJSONBody } from 'discord-api-types/v10';
import type { BodyReadResult, DiscordInteraction } from './types.js';

const MAX_BODY_BYTES = 64 * 1024;
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const DISCORD_API_BASE = 'https://discord.com/api/v10';

export function normalizeNotionPageId(rawId?: string): string | null {
	if (!rawId) return null;
	const id = rawId.replaceAll('-', '');
	if (!/^[0-9a-f]{32}$/i.test(id)) return null;
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toLowerCase();
}

export function isDiscordInteraction(value: unknown): value is DiscordInteraction {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const interaction = value as Record<string, unknown>;
	return (
		typeof interaction.id === 'string' &&
		typeof interaction.application_id === 'string' &&
		typeof interaction.type === 'number' &&
		(interaction.token === undefined || typeof interaction.token === 'string') &&
		(interaction.guild_id === undefined || typeof interaction.guild_id === 'string') &&
		(interaction.channel_id === undefined || typeof interaction.channel_id === 'string') &&
		(interaction.channel === undefined || isPartialChannel(interaction.channel)) &&
		(interaction.data === undefined || isApplicationCommandData(interaction.data))
	);
}

function isPartialChannel(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const channel = value as Record<string, unknown>;
	return (
		(channel.id === undefined || typeof channel.id === 'string') &&
		(channel.type === undefined || typeof channel.type === 'number') &&
		(channel.guild_id === undefined || typeof channel.guild_id === 'string')
	);
}

function isApplicationCommandData(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const data = value as Record<string, unknown>;
	return (
		(data.name === undefined || typeof data.name === 'string') &&
		(data.custom_id === undefined || typeof data.custom_id === 'string') &&
		(data.values === undefined || (Array.isArray(data.values) && data.values.every((item) => typeof item === 'string'))) &&
		(data.options === undefined || (Array.isArray(data.options) && data.options.every(isApplicationCommandOption)))
	);
}

function isApplicationCommandOption(value: unknown): value is { name: string; type: number; value: unknown } {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const option = value as Record<string, unknown>;
	return typeof option.name === 'string' && typeof option.type === 'number' && 'value' in option;
}

export async function readBoundedBody(request: Request): Promise<BodyReadResult> {
	const contentLength = request.headers.get('Content-Length');
	if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
		return { ok: false, reason: 'too-large' };
	}
	if (!request.body) {
		return { ok: true, bytes: new Uint8Array() };
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, reason: 'too-large' };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: 'read-failed' };
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

export async function verifyDiscordSignature(
	signatureHex: string,
	timestamp: string,
	body: Uint8Array,
	publicKeyHex: string,
): Promise<boolean> {
	const signature = decodeHex(signatureHex, 64);
	const publicKeyBytes = decodeHex(publicKeyHex, 32);
	if (!signature || !publicKeyBytes || !/^\d{1,20}$/.test(timestamp)) {
		return false;
	}

	const timestampBytes = new TextEncoder().encode(timestamp);
	const signedMessage = new Uint8Array(timestampBytes.byteLength + body.byteLength);
	signedMessage.set(timestampBytes, 0);
	signedMessage.set(body, timestampBytes.byteLength);

	try {
		const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
		return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, signedMessage);
	} catch {
		return false;
	}
}

function decodeHex(value: string, byteLength: number): Uint8Array | null {
	if (value.length !== byteLength * 2 || !/^[0-9a-f]+$/i.test(value)) {
		return null;
	}
	const bytes = new Uint8Array(byteLength);
	for (let index = 0; index < byteLength; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

export function interactionMessage(content: string): Response {
	return Response.json({ type: 4, data: { content, flags: 64 } });
}

export async function editOriginalResponse(
	applicationId: string,
	token: string,
	message: RESTPatchAPIInteractionOriginalResponseJSONBody,
): Promise<void> {
	try {
		const response = await fetch(
			`${DISCORD_API_BASE}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(typeof message === 'string' ? { content: message } : message),
			},
		);
		if (!response.ok) {
			console.error(JSON.stringify({ message: 'Failed to update Discord interaction response', status: response.status }));
		}
	} catch (error) {
		console.error(
			JSON.stringify({
				message: 'Failed to update Discord interaction response',
				error: error instanceof Error ? error.name : 'unknown',
			}),
		);
	}
}

export async function createFollowupMessage(
	applicationId: string,
	token: string,
	message: RESTPatchAPIInteractionOriginalResponseJSONBody,
): Promise<boolean> {
	try {
		const response = await fetch(
			`${DISCORD_API_BASE}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}?wait=true&with_components=true`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(message),
			},
		);
		if (!response.ok) {
			console.error(JSON.stringify({ message: 'Failed to create Discord interaction followup', status: response.status }));
		}
		return response.ok;
	} catch (error) {
		console.error(
			JSON.stringify({
				message: 'Failed to create Discord interaction followup',
				error: error instanceof Error ? error.name : 'unknown',
			}),
		);
		return false;
	}
}
