import type { WorkerEnv } from '../env.js';
import type { VoiceSession } from '../sessions/types.js';
import { createMeetingPage, getNotionPage, searchNotionPages } from '../notion/meeting-pages.js';

const MAX_BODY_BYTES = 64 * 1024;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const DISCORD_API_BASE = 'https://discord.com/api/v10';

type DiscordInteraction = {
	id: string;
	application_id: string;
	type: number;
	token?: string;
	guild_id?: string;
	channel_id?: string;
	channel?: {
		id?: string;
		type?: number;
		guild_id?: string;
	};
	member?: { permissions?: string };
	data?: {
		name?: string;
		options?: Array<{ name?: string; type?: number; value?: unknown; focused?: boolean }>;
	};
};

type ParsedCommand = {
	action: 'start' | 'stop' | 'imakita' | 'notion_retry' | 'notion_default';
	guildId: string;
	channelId: string;
	notionParentPageId: string | null;
	notionDefaultAction: 'set' | 'clear' | 'show' | null;
	canManageGuild: boolean;
};

type CommandParseResult = { ok: true; command: ParsedCommand } | { ok: false; reason: 'unsupported' };

type BodyReadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too-large' | 'read-failed' };

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
	if (value.type === 4) {
		if (!value.token || !SNOWFLAKE_PATTERN.test(value.id)) {
			return Response.json({ type: 8, data: { choices: [] } });
		}
		return handleAutocomplete(value, env);
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
			'対象のボイスチャンネルのチャットで `/start`、`/stop`、`/imakita`、`/notion_retry`、または `/notion_default` を実行してください。',
		);
	}

	const command = parsed.command;
	ctx.waitUntil(processCommand(command, value, env));
	return Response.json({ type: 5, data: { flags: 64 } });
}

async function processCommand(command: ParsedCommand, interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
	const token = interaction.token;
	if (!token) {
		return;
	}

	if (command.action === 'imakita') {
		await editOriginalResponse(env.DISCORD_APPLICATION_ID, token, '今北産業を作成しています。文字起こしの確定を待つ場合があります。');
	}

	let content: string | null;
	try {
		content = await executeCommand(command, interaction.id, token, env);
	} catch (error) {
		console.error(
			JSON.stringify({
				message: 'Discord interaction command failed',
				command: command.action,
				guildId: command.guildId,
				channelId: command.channelId,
				error: error instanceof Error ? error.name : 'unknown',
			}),
		);
		content = 'コマンドを処理できませんでした。しばらくしてからもう一度お試しください。';
	}

	if (content !== null) {
		await editOriginalResponse(env.DISCORD_APPLICATION_ID, token, content);
	}
}

async function executeCommand(
	command: ParsedCommand,
	interactionId: string,
	interactionToken: string,
	env: WorkerEnv,
): Promise<string | null> {
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${command.guildId}:${command.channelId}`);
	if (command.action === 'notion_default') {
		if (!command.canManageGuild) return '既定の保存先を変更するにはサーバー管理権限が必要です。';
		if (command.notionDefaultAction === 'clear') {
			await session.setNotionDefault(null);
			return 'この VC の既定Notion保存先を解除しました。';
		}
		if (command.notionDefaultAction !== 'set' || !command.notionParentPageId) {
			const current = await session.getNotionDefault();
			return current?.pageUrl
				? `この VC の既定保存先: [${current.title}](<${current.pageUrl}>)。候補を選ぶと変更できます。`
				: '既定保存先は未設定です。候補からNotionページを選んでください。';
		}
		const page = await getNotionPage(env, command.notionParentPageId);
		if (!page) return 'Notionページを取得できませんでした。Botにページを共有してから、もう一度選んでください。';
		await session.setNotionDefault(page);
		return page.pageUrl
			? `この VC の既定保存先を [${page.title}](<${page.pageUrl}>) に設定しました。`
			: `この VC の既定保存先を「${page.title}」に設定しました。`;
	}
	if (command.action === 'start') {
		const notionParentPageId = command.notionParentPageId ?? (await session.getNotionDefault())?.pageId ?? null;
		if (!notionParentPageId) return 'この VC の既定保存先が未設定です。`/notion_default` からNotionページを選んでください。';
		const result = await session.startSession(command.guildId, command.channelId, interactionId, notionParentPageId);
		if (!result.ok) {
			return result.code === 'SESSION_ALREADY_ACTIVE'
				? `この VC はすでに録音中です: <#${command.channelId}>`
				: '録音セッションを開始できませんでした。';
		}

		if (result.session.state !== 'starting') {
			return sessionStateMessage(result.session, command.channelId);
		}
		const queued = await env.GATEWAY_CONTROL.getByName('default').enqueueCommand({
			commandId: interactionId,
			action: 'start',
			guildId: command.guildId,
			channelId: command.channelId,
			sessionId: result.session.sessionId,
		});

		let notionPageUrl = result.session.notionPageUrl;
		let notionPageCreationFailed = false;
		if (result.session.notionParentPageId && !result.session.notionPageId) {
			try {
				const creating = await session.markNotionPageCreating(result.session.sessionId);
				if (!creating.ok) {
					throw new Error(`Could not update Notion page status: ${creating.code}`);
				}
				if (!creating.claimed) {
					notionPageUrl = creating.session.notionPageUrl;
				} else {
					const page = await createMeetingPage(env, creating.session);
					const savedPage = await session.setNotionPage(result.session.sessionId, page.pageId, page.pageUrl);
					if (!savedPage.ok) {
						throw new Error(`Could not save Notion page ID: ${savedPage.code}`);
					}
					notionPageUrl = savedPage.session.notionPageUrl;
				}
			} catch (error) {
				notionPageCreationFailed = true;
				const message = error instanceof Error ? error.message : 'unknown error';
				try {
					await session.failNotionPageCreation(result.session.sessionId, message);
				} catch (statusError) {
					console.error(
						'[notion] could not persist initial page failure',
						statusError instanceof Error ? statusError.message : 'unknown error',
					);
				}
				console.error('[notion] initial page creation failed', message);
			}
		}

		const notionMessage = notionPageUrl
			? ` Notionページ: <${notionPageUrl}>（録音終了後に内容を更新します）`
			: notionParentPageId
				? notionPageCreationFailed
					? ' Notionページの作成に失敗したため、録音終了後に再試行します。'
					: ' Notionページは録音終了後に更新します。'
				: '';
		return queued.gatewayConnected
			? `録音の開始要求を送信しました: <#${command.channelId}>${notionMessage}`
			: `開始要求を受け付けました。Gateway の接続待ちです: <#${command.channelId}>${notionMessage}`;
	}

	if (command.action === 'notion_retry') {
		const retriedSession = await session.retryLatestNotionExport();
		if (!retriedSession) {
			return '再試行できるNotion議事録はありません。';
		}
		return retriedSession.notionPageUrl
			? `Notion議事録の保存を再試行します: <${retriedSession.notionPageUrl}>`
			: 'Notion議事録の保存を再試行します。';
	}

	const active = await session.getActiveSession();
	if (command.action === 'imakita') {
		if (!active || active.guildId !== command.guildId || active.channelId !== command.channelId) {
			return 'この VC では録音していません。';
		}
		if (active.state !== 'recording') {
			return active.state === 'processing' ? '録音を終了し、文字起こしを処理中です。' : 'この VC はまだ録音を開始していません。';
		}
		await env.GATEWAY_CONTROL.getByName('default').enqueueCommand({
			commandId: interactionId,
			action: 'imakita',
			guildId: command.guildId,
			channelId: command.channelId,
			sessionId: active.sessionId,
			applicationId: env.DISCORD_APPLICATION_ID,
			interactionToken,
		});
		return null;
	}
	if (!active || active.guildId !== command.guildId || active.channelId !== command.channelId) {
		return `この VC では録音していません: <#${command.channelId}>`;
	}
	if (active.state !== 'starting' && active.state !== 'recording') {
		return active.state === 'processing'
			? `録音は終了し、文字起こしを処理中です: <#${command.channelId}>`
			: `この VC では録音していません: <#${command.channelId}>`;
	}

	const queued = await env.GATEWAY_CONTROL.getByName('default').enqueueCommand({
		commandId: interactionId,
		action: 'stop',
		guildId: command.guildId,
		channelId: command.channelId,
		sessionId: active.sessionId,
	});
	return queued.gatewayConnected
		? `録音の停止要求を送信しました: <#${command.channelId}>`
		: `停止要求を受け付けました。Gateway の接続待ちです: <#${command.channelId}>`;
}

function sessionStateMessage(session: VoiceSession, channelId: string): string {
	if (session.state === 'recording') {
		return `この VC はすでに録音中です: <#${channelId}>`;
	}
	if (session.state === 'processing') {
		return `録音は終了し、文字起こしを処理中です: <#${channelId}>`;
	}
	if (session.state === 'completed') {
		return `この VC の録音は完了しています: <#${channelId}>`;
	}
	return '録音セッションを開始できませんでした。';
}

async function handleAutocomplete(interaction: DiscordInteraction, env: WorkerEnv): Promise<Response> {
	const data = interaction.data;
	const option = data?.options?.find((item) => item.focused);
	const isDefaultCommand = data?.name === 'notion_default';
	const permissions = interaction.member?.permissions;
	const canManageGuild = permissions !== undefined && /^\d+$/.test(permissions) && (BigInt(permissions) & 40n) !== 0n;
	if (
		!interaction.guild_id ||
		!SNOWFLAKE_PATTERN.test(interaction.guild_id) ||
		!interaction.channel_id ||
		!SNOWFLAKE_PATTERN.test(interaction.channel_id) ||
		(data?.name !== 'start' && !isDefaultCommand) ||
		(isDefaultCommand && !canManageGuild) ||
		!option ||
		option.name !== (isDefaultCommand ? 'page' : 'notion_page')
	) {
		return Response.json({ type: 8, data: { choices: [] } });
	}

	const query = typeof option.value === 'string' ? option.value.slice(0, 100) : '';
	try {
		const pages = await searchNotionPages(env, query);
		const choices = pages.slice(0, isDefaultCommand ? 24 : 25).map((page) => ({ name: page.title.slice(0, 100), value: page.pageId }));
		if (isDefaultCommand) choices.push({ name: '既定の保存先を解除', value: '__clear_default__' });
		return Response.json({ type: 8, data: { choices } });
	} catch (error) {
		console.error('[notion] page search failed', error instanceof Error ? error.name : 'unknown error');
		return Response.json({ type: 8, data: { choices: [] } });
	}
}

function parseCommand(interaction: DiscordInteraction): CommandParseResult {
	const guildId = interaction.guild_id;
	const channelId = interaction.channel_id;
	const sourceChannel = interaction.channel;
	const name = interaction.data?.name;
	if (
		!guildId ||
		!SNOWFLAKE_PATTERN.test(guildId) ||
		!channelId ||
		!SNOWFLAKE_PATTERN.test(channelId) ||
		(sourceChannel !== undefined &&
			(sourceChannel.id !== channelId ||
				(sourceChannel.type !== undefined && sourceChannel.type !== 2) ||
				(sourceChannel.guild_id !== undefined && sourceChannel.guild_id !== guildId))) ||
		(name !== 'start' && name !== 'stop' && name !== 'imakita' && name !== 'notion_retry' && name !== 'notion_default')
	) {
		return { ok: false, reason: 'unsupported' };
	}

	const optionName = name === 'start' ? 'notion_page' : name === 'notion_default' ? 'page' : null;
	const option = optionName ? interaction.data?.options?.find((item) => item.name === optionName) : undefined;
	const selectedValue = option && typeof option.value === 'string' ? option.value : null;
	const notionParentPageId = selectedValue && selectedValue !== '__clear_default__' ? normalizeNotionPageId(selectedValue) : null;
	if (selectedValue && selectedValue !== '__clear_default__' && !notionParentPageId) return { ok: false, reason: 'unsupported' };
	const notionDefaultAction =
		name !== 'notion_default' ? null : selectedValue === '__clear_default__' ? 'clear' : notionParentPageId ? 'set' : 'show';
	const permissions = interaction.member?.permissions;
	const canManageGuild = permissions !== undefined && /^\d+$/.test(permissions) && (BigInt(permissions) & 40n) !== 0n;
	return { ok: true, command: { action: name, guildId, channelId, notionParentPageId, notionDefaultAction, canManageGuild } };
}

function normalizeNotionPageId(rawId?: string): string | null {
	if (!rawId) return null;
	const id = rawId.replaceAll('-', '');
	if (!/^[0-9a-f]{32}$/i.test(id)) return null;
	return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`.toLowerCase();
}

function isDiscordInteraction(value: unknown): value is DiscordInteraction {
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

async function readBoundedBody(request: Request): Promise<BodyReadResult> {
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

async function verifyDiscordSignature(signatureHex: string, timestamp: string, body: Uint8Array, publicKeyHex: string): Promise<boolean> {
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

function interactionMessage(content: string): Response {
	return Response.json({ type: 4, data: { content, flags: 64 } });
}

async function editOriginalResponse(applicationId: string, token: string, content: string): Promise<void> {
	try {
		const response = await fetch(
			`${DISCORD_API_BASE}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(token)}/messages/@original`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
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
