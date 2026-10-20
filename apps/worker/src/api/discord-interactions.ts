import type { APIInteractionResponse } from 'discord-api-types/v10';
import type { WorkerEnv } from '../env.js';
import { handleComponentInteraction } from './discord-interactions/components.js';
import { parseCommand, processCommand } from './discord-interactions/commands.js';
import {
	interactionMessage,
	isDiscordInteraction,
	readBoundedBody,
	SNOWFLAKE_PATTERN,
	verifyDiscordSignature,
} from './discord-interactions/protocol.js';

export async function handleDiscordInteraction(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
	}

	if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_APPLICATION_PUBLIC_KEY) {
		return new Response('Discord interaction configuration is missing', { status: 500 });
	}

	const body = await readBoundedBody(request);
	if (!body.ok) {
		return new Response(body.reason === 'too-large' ? 'Payload too large' : 'Unable to read request body', {
			status: body.reason === 'too-large' ? 413 : 400,
		});
	}

	const signature = request.headers.get('X-Signature-Ed25519') ?? '';
	const timestamp = request.headers.get('X-Signature-Timestamp') ?? '';
	if (!(await verifyDiscordSignature(signature, timestamp, body.bytes, env.DISCORD_APPLICATION_PUBLIC_KEY))) {
		return new Response('Invalid request signature', { status: 401 });
	}

	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.bytes));
	} catch {
		return new Response('Invalid JSON payload', { status: 400 });
	}
	if (!isDiscordInteraction(value)) {
		return new Response('Invalid interaction payload', { status: 400 });
	}
	if (value.application_id !== env.DISCORD_APPLICATION_ID) {
		return new Response('Unexpected application ID', { status: 401 });
	}

	if (value.type === 1) {
		return Response.json({ type: 1 });
	}
	if (value.type === 3) {
		if (!value.token || !SNOWFLAKE_PATTERN.test(value.id)) {
			return interactionMessage('この操作には対応していません。');
		}
		return handleComponentInteraction(value, env, ctx);
	}
	if (value.type === 4) {
		return Response.json({ type: 8, data: { choices: [] } });
	}
	if (value.type !== 2) {
		return new Response('Unsupported interaction type', { status: 400 });
	}
	if (!value.token || !SNOWFLAKE_PATTERN.test(value.id)) {
		return interactionMessage('この操作には対応していません。');
	}

	const parsed = parseCommand(value);
	if (!parsed.ok) {
		return interactionMessage(
			'対象のボイスチャンネルのチャットで `/meeting`、`/meeting_stop`、`/imakinta`、`/status`、または `/meeting_notion_retry` を実行してください。',
		);
	}

	const command = parsed.command;
	ctx.waitUntil(processCommand(command, value, env));
	const deferredResponse: APIInteractionResponse = {
		type: 5,
		...(command.action === 'start' || command.action === 'stop' ? {} : { data: { flags: 64 } }),
	};
	return Response.json(deferredResponse);
}
