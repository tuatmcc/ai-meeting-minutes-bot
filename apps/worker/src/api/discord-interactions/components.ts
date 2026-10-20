import type { WorkerEnv } from '../../env.js';
import { getNotionDataSource, queryNotionDataSource, searchNotionDataSources } from '../../notion/meeting-pages.js';
import type { NotionDataSource } from '../../notion/meeting-pages.js';
import { processCommand } from './commands.js';
import { editOriginalResponse, interactionMessage, normalizeNotionPageId, SNOWFLAKE_PATTERN } from './protocol.js';
import { meetingMessage, notionDatabasePickerMessage, notionParentPagePickerMessage } from './views.js';
import type { ComponentContext, DiscordInteraction } from './types.js';

export async function handleComponentInteraction(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const customId = interaction.data?.custom_id;
	if (customId === 'meeting_setup_discord') return Response.json({ type: 6 });

	const componentContext = parseComponentContext(interaction);
	if (!componentContext) return interactionMessage('この操作には対応していません。');
	switch (customId) {
		case 'meeting_stop':
			ctx.waitUntil(
				processCommand(
					{
						action: 'stop',
						guildId: componentContext.guildId,
						channelId: componentContext.channelId,
						notionParentPageId: null,
						notionDatabaseId: null,
						canManageGuild: componentContext.canManageGuild,
					},
					interaction,
					env,
					true,
					false,
					true,
				),
			);
			return Response.json({ type: 6 });
		case 'meeting_setup_notion':
			if (!componentContext.canManageGuild) return interactionMessage('Notion の保存先を設定するにはサーバー管理権限が必要です。');
			ctx.waitUntil(showNotionDatabasePicker(interaction, componentContext, env));
			return Response.json({ type: 6 });
		case 'meeting_select_notion_database': {
			if (!componentContext.canManageGuild) return interactionMessage('Notion の保存先を設定するにはサーバー管理権限が必要です。');
			const selectedId = interaction.data?.values?.length === 1 ? normalizeNotionPageId(interaction.data.values[0]) : null;
			if (!selectedId) return interactionMessage('Notion データベースを候補から選択してください。');
			ctx.waitUntil(saveNotionDatabase(interaction, componentContext, selectedId, env));
			return Response.json({ type: 6 });
		}
		case 'meeting_retry_notion_pages':
			ctx.waitUntil(showNotionPagePicker(interaction, componentContext, env));
			return Response.json({ type: 6 });
		case 'meeting_select_notion_page': {
			const notionParentPageId = interaction.data?.values?.length === 1 ? normalizeNotionPageId(interaction.data.values[0]) : null;
			if (!notionParentPageId) return interactionMessage('Notion の親ページを候補から選択してください。');
			ctx.waitUntil(
				processCommand(
					{
						action: 'start',
						guildId: componentContext.guildId,
						channelId: componentContext.channelId,
						notionParentPageId,
						notionDatabaseId: null,
						canManageGuild: componentContext.canManageGuild,
					},
					interaction,
					env,
					true,
					true,
				),
			);
			return Response.json({ type: 6 });
		}
		case 'meeting_setup_cancel':
			ctx.waitUntil(showMeetingMessage(interaction, env));
			return Response.json({ type: 6 });
		default:
			return interactionMessage('この操作には対応していません。');
	}
}

function parseComponentContext(interaction: DiscordInteraction): ComponentContext | null {
	const guildId = interaction.guild_id;
	const channelId = interaction.channel_id;
	const sourceChannel = interaction.channel;
	if (
		!guildId ||
		!SNOWFLAKE_PATTERN.test(guildId) ||
		!channelId ||
		!SNOWFLAKE_PATTERN.test(channelId) ||
		(sourceChannel !== undefined &&
			(sourceChannel.id !== channelId ||
				(sourceChannel.type !== undefined && sourceChannel.type !== 2) ||
				(sourceChannel.guild_id !== undefined && sourceChannel.guild_id !== guildId)))
	) {
		return null;
	}
	const permissions = interaction.member?.permissions;
	const canManageGuild = permissions !== undefined && /^\d+$/.test(permissions) && (BigInt(permissions) & 40n) !== 0n;
	return { guildId, channelId, canManageGuild };
}

async function showNotionDatabasePicker(
	interaction: DiscordInteraction,
	componentContext: ComponentContext,
	env: WorkerEnv,
): Promise<void> {
	if (!interaction.token) return;
	if (!env.NOTION_API_TOKEN) {
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionDatabasePickerMessage([], 'Notion 連携が設定されていません。'),
		);
		return;
	}
	try {
		const databases = await searchNotionDataSources(env, '');
		await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, notionDatabasePickerMessage(databases));
	} catch (error) {
		console.error('[notion] database search failed', error instanceof Error ? error.name : 'unknown error');
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionDatabasePickerMessage([], 'Notion データベースを取得できませんでした。時間をおいて再試行してください。'),
		);
	}
}

async function saveNotionDatabase(
	interaction: DiscordInteraction,
	componentContext: ComponentContext,
	databaseId: string,
	env: WorkerEnv,
): Promise<void> {
	if (!interaction.token) return;
	try {
		const database = await getNotionDataSource(env, databaseId);
		if (!database) {
			await editOriginalResponse(
				env.DISCORD_APPLICATION_ID,
				interaction.token,
				notionDatabasePickerMessage([], '選択したデータベースを取得できませんでした。もう一度選択してください。'),
			);
			return;
		}
		const session = env.VOICE_CHANNEL_SESSION.getByName(`${componentContext.guildId}:${componentContext.channelId}`);
		await session.setNotionDatabase(database);
		await showNotionPagePicker(interaction, componentContext, env, database);
	} catch (error) {
		console.error('[notion] database save failed', error instanceof Error ? error.name : 'unknown error');
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionDatabasePickerMessage([], 'Notion の保存先を設定できませんでした。時間をおいて再試行してください。'),
		);
	}
}

async function showNotionPagePicker(
	interaction: DiscordInteraction,
	componentContext: ComponentContext,
	env: WorkerEnv,
	selectedDatabase?: NotionDataSource,
): Promise<void> {
	if (!interaction.token) return;
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${componentContext.guildId}:${componentContext.channelId}`);
	const database = selectedDatabase ?? (await session.getNotionDatabase());
	if (!database) {
		await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, meetingMessage('この VC の議事録 DB が未設定です。'));
		return;
	}
	try {
		const pages = await queryNotionDataSource(env, database, '');
		const notice =
			pages.length === 0
				? 'このデータベースに選択できるページがありません。Notion の共有設定を確認して再読み込みしてください。'
				: undefined;
		await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, notionParentPagePickerMessage(database.title, pages, notice));
	} catch (error) {
		console.error('[notion] database page query failed', error instanceof Error ? error.name : 'unknown error');
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionParentPagePickerMessage(
				database.title,
				[],
				'データベース内のページを取得できませんでした。時間をおいて再読み込みしてください。',
			),
		);
	}
}

async function showMeetingMessage(interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
	if (!interaction.token) return;
	await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, meetingMessage());
}
