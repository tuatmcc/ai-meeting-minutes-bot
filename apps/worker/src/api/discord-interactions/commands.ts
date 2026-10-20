import type { APIEmbed } from 'discord-api-types/v10';
import type { WorkerEnv } from '../../env.js';
import { summarizeForCatchUp } from '../../ai/summaries.js';
import {
	commandMessageAsComponentsV2,
	formatSessionStatus,
	meetingMessage,
	recordingMessage,
	recordingMessageWithoutStopButton,
	sessionStateMessage,
} from './views.js';
import { createFollowupMessage, editOriginalResponse, SNOWFLAKE_PATTERN } from './protocol.js';
import type { CommandMessage, CommandParseResult, DiscordInteraction, ParsedCommand } from './types.js';

export async function processCommand(
	command: ParsedCommand,
	interaction: DiscordInteraction,
	env: WorkerEnv,
	preserveComponentsV2 = false,
	publishStartFollowup = false,
	publishStopFollowup = false,
): Promise<void> {
	const token = interaction.token;
	if (!token) {
		return;
	}

	if (command.action === 'imakita') {
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			token,
			commandMessageAsComponentsV2('今北産業を作成しています。文字起こしの確定を待つ場合があります。'),
		);
	}

	let message: CommandMessage;
	try {
		message = await executeCommand(command, interaction.id, env);
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
		message = 'コマンドを処理できませんでした。しばらくしてからもう一度お試しください。';
	}

	const response = typeof message === 'string' ? { content: message } : message;
	const responseUsesComponentsV2 =
		preserveComponentsV2 ||
		(command.action === 'start' && typeof message !== 'string') ||
		command.action === 'status' ||
		command.action === 'imakita';
	if (publishStopFollowup && command.action === 'stop') {
		const published = await createFollowupMessage(env.DISCORD_APPLICATION_ID, token, commandMessageAsComponentsV2(message));
		if (published && interaction.message) {
			await editOriginalResponse(env.DISCORD_APPLICATION_ID, token, recordingMessageWithoutStopButton(interaction.message));
			return;
		}
	}
	if (publishStartFollowup && command.action === 'start' && typeof message !== 'string') {
		const followup = commandMessageAsComponentsV2(message);
		const published = await createFollowupMessage(env.DISCORD_APPLICATION_ID, token, followup);
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			token,
			commandMessageAsComponentsV2(
				published ? '録音の開始通知をチャンネルに投稿しました。' : 'チャンネルへの通知に失敗しました。録音は開始されています。',
			),
		);
		return;
	}
	await editOriginalResponse(
		env.DISCORD_APPLICATION_ID,
		token,
		responseUsesComponentsV2 ? commandMessageAsComponentsV2(message) : response,
	);
}

async function executeCommand(command: ParsedCommand, interactionId: string, env: WorkerEnv): Promise<CommandMessage> {
	switch (command.action) {
		case 'meeting':
			return meetingMessage();
		case 'start':
			return startRecording(command, interactionId, env);
		case 'stop':
			return stopRecording(command, interactionId, env);
		case 'status':
			return showRecordingStatus(command, env);
		case 'imakita':
			return createCatchUpSummary(command, env);
		case 'notion_retry':
			return retryNotionExport(command, env);
		default: {
			const unreachable: never = command.action;
			return unreachable;
		}
	}
}

async function startRecording(command: ParsedCommand, interactionId: string, env: WorkerEnv): Promise<CommandMessage> {
	const notionParentPageId = command.notionParentPageId;
	if (!notionParentPageId) return 'Notion の親ページを選択してください。';
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${command.guildId}:${command.channelId}`);

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
		...(result.resumed ? { resume: { segmentIndexOffset: result.segmentIndexOffset ?? 0, timeOffsetMs: result.timeOffsetMs ?? 0 } } : {}),
	});

	let notionPageId = result.session.notionPageId;
	let notionPageUrl = result.session.notionPageUrl;
	let notionPageCreationFailed = false;
	if (result.session.notionParentPageId && !notionPageId) {
		try {
			const ensured = await session.ensureMeetingPage(result.session.sessionId);
			if (!ensured.ok) throw new Error(`Could not create Notion page: ${ensured.code}`);
			notionPageId = ensured.session.notionPageId;
			notionPageUrl = ensured.session.notionPageUrl;
			notionPageCreationFailed = !notionPageId;
		} catch (error) {
			notionPageCreationFailed = true;
			const message = error instanceof Error ? error.message : 'unknown error';
			console.error('[notion] initial page creation failed', message);
		}
	}

	const action = result.resumed ? '録音セッションを再開します' : '録音の開始要求を送信しました';
	return recordingMessage(
		result.resumed ? '録音セッションを再開します' : '録音の開始要求を送信しました',
		queued.gatewayConnected
			? `${action}: <#${command.channelId}>`
			: `${result.resumed ? '再開要求を受け付けました' : '開始要求を受け付けました'}。Gateway の接続待ちです: <#${command.channelId}>`,
		{ ...result.session, notionPageId, notionPageUrl },
		notionPageCreationFailed,
	);
}

async function stopRecording(command: ParsedCommand, interactionId: string, env: WorkerEnv): Promise<CommandMessage> {
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${command.guildId}:${command.channelId}`);
	const active = await session.getActiveSession();
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
	const embed: APIEmbed = {
		title: '録音終了要求を送信しました',
		description: queued.gatewayConnected
			? `録音の停止要求を送信しました: <#${command.channelId}>`
			: `停止要求を受け付けました。Gateway の接続待ちです: <#${command.channelId}>`,
		color: 0x5865f2,
	};
	return { embeds: [embed] };
}

async function showRecordingStatus(command: ParsedCommand, env: WorkerEnv): Promise<CommandMessage> {
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${command.guildId}:${command.channelId}`);
	const active = await session.getActiveSession();
	const gatewayStatus = await env.GATEWAY_CONTROL.getByName('default').getConnectionStatus();
	const latest = active ?? (await session.getLatestSession());
	return latest
		? formatSessionStatus(latest, gatewayStatus)
		: `録音状態: セッションなし\nGateway: ${gatewayStatus === 'connected' ? '接続中' : '未接続'}`;
}

async function createCatchUpSummary(command: ParsedCommand, env: WorkerEnv): Promise<CommandMessage> {
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${command.guildId}:${command.channelId}`);
	const active = await session.getActiveSession();
	if (!active || active.guildId !== command.guildId || active.channelId !== command.channelId) {
		return 'この VC では録音していません。';
	}
	if (active.state !== 'recording') {
		return active.state === 'processing' ? '録音を終了し、文字起こしを処理中です。' : 'この VC はまだ録音を開始していません。';
	}
	const transcript = await session.getFinalizedTranscript(active.sessionId);
	if (transcript === null) return 'この VC では録音していません。';
	if (!transcript) return '確定した文字起こしがありません。文字起こしの確定後にもう一度お試しください。';
	const summary = await summarizeForCatchUp(env, transcript);
	const content = `**今北産業**\n${summary}`;
	return content.length > 1_900 ? `${content.slice(0, 1_897)}…` : content;
}

async function retryNotionExport(command: ParsedCommand, env: WorkerEnv): Promise<CommandMessage> {
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${command.guildId}:${command.channelId}`);
	const retriedSession = await session.retryLatestNotionExport();
	if (!retriedSession) {
		return '再試行できるNotion議事録はありません。';
	}
	return retriedSession.notionPageUrl
		? `Notion議事録の保存を再試行します: <${retriedSession.notionPageUrl}>`
		: 'Notion議事録の保存を再試行します。';
}

export function parseCommand(interaction: DiscordInteraction): CommandParseResult {
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
		(name !== 'meeting' && name !== 'meeting_stop' && name !== 'imakinta' && name !== 'status' && name !== 'meeting_notion_retry')
	) {
		return { ok: false, reason: 'unsupported' };
	}

	let action: ParsedCommand['action'];
	switch (name) {
		case 'meeting':
			action = 'meeting';
			break;
		case 'meeting_stop':
			action = 'stop';
			break;
		case 'imakinta':
			action = 'imakita';
			break;
		case 'status':
			action = 'status';
			break;
		case 'meeting_notion_retry':
			action = 'notion_retry';
			break;
		default:
			return { ok: false, reason: 'unsupported' };
	}

	return {
		ok: true,
		command: {
			action,
			guildId,
			channelId,
			notionParentPageId: null,
		},
	};
}
