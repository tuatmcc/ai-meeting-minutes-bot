import type { WorkerEnv } from '../../env.js';
import { getNotionDataSource, queryNotionDataSource, searchNotionDataSources } from '../../notion/meeting-pages.js';
import type { NotionDataSource } from '../../notion/meeting-pages.js';
import { processCommand } from './commands.js';
import { editOriginalResponse, interactionMessage, normalizeNotionPageId, SNOWFLAKE_PATTERN } from './protocol.js';
import { discordOnlyUnavailableMessage, meetingMessage, notionDatabasePickerMessage, notionParentPagePickerMessage } from './views.js';
import type { ComponentContext, DiscordInteraction } from './types.js';

export async function handleComponentInteraction(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const customId = interaction.data?.custom_id;
	if (customId === 'meeting_setup_discord') {
		ctx.waitUntil(showDiscordOnlyUnavailableMessage(interaction, env));
		return Response.json({ type: 6 });
	}

	const componentContext = parseComponentContext(interaction);
	if (!componentContext) return interactionMessage('この操作には対応していません。');
	if (customId?.startsWith('meeting_retry_notion_pages:')) {
		const [, rawDataSourceId, rememberValue] = customId.match(/^meeting_retry_notion_pages:([^:]+)(?::([01]))?$/) ?? [];
		const dataSourceId = normalizeNotionPageId(rawDataSourceId);
		if (!dataSourceId) return interactionMessage('Notion データベースを取得できませんでした。もう一度選択してください。');
		ctx.waitUntil(showNotionPagePickerForSelection(interaction, dataSourceId, env, rememberValue === '1'));
		return Response.json({ type: 6 });
	}
	const nextDatabase = customId?.match(/^meeting_next_notion_database:([^:]+):([01])$/);
	if (nextDatabase) {
		const dataSourceId = normalizeNotionPageId(nextDatabase[1]);
		if (!dataSourceId) return interactionMessage('Notion データベースを候補から選択してください。');
		ctx.waitUntil(showNotionPagePickerForSelection(interaction, dataSourceId, env, nextDatabase[2] === '1'));
		return Response.json({ type: 6 });
	}
	const backPage = customId?.match(/^meeting_back_notion_page:([^:]+):([01])$/);
	if (backPage) {
		const dataSourceId = normalizeNotionPageId(backPage[1]);
		if (!dataSourceId) return interactionMessage('Notion データベースを候補から選択してください。');
		ctx.waitUntil(showNotionDatabasePicker(interaction, env, dataSourceId, backPage[2] === '1'));
		return Response.json({ type: 6 });
	}
	const nextPage = customId?.match(/^meeting_next_notion_page:([^:]+):([^:]+):([01])$/);
	if (nextPage) {
		const dataSourceId = normalizeNotionPageId(nextPage[1]);
		const notionParentPageId = normalizeNotionPageId(nextPage[2]);
		if (!dataSourceId || !notionParentPageId) return interactionMessage('議事録の回を候補から選択してください。');
		ctx.waitUntil(
			processCommand(
				{
					action: 'start',
					guildId: componentContext.guildId,
					channelId: componentContext.channelId,
					notionParentPageId,
					notionDataSourceId: dataSourceId,
					rememberNotionParentPage: nextPage[3] === '1',
				},
				interaction,
				env,
				true,
				true,
			),
		);
		return Response.json({ type: 6 });
	}
	const toggleRemember = customId?.match(/^meeting_toggle_notion_remember:([^:]+):([01])$/);
	if (toggleRemember) {
		const dataSourceId = normalizeNotionPageId(toggleRemember[1]);
		if (!dataSourceId) return interactionMessage('Notion データベースを候補から選択してください。');
		ctx.waitUntil(showNotionDatabasePicker(interaction, env, dataSourceId, toggleRemember[2] === '1'));
		return Response.json({ type: 6 });
	}
	const selectedDatabase = customId?.match(/^meeting_select_notion_database(?::([01]))?$/);
	if (selectedDatabase) {
		const selectedId = interaction.data?.values?.length === 1 ? normalizeNotionPageId(interaction.data.values[0]) : null;
		if (!selectedId) return interactionMessage('Notion データベースを候補から選択してください。');
		ctx.waitUntil(showNotionDatabasePicker(interaction, env, selectedId, selectedDatabase[1] === '1'));
		return Response.json({ type: 6 });
	}
	const selectedPage = customId?.match(/^meeting_select_notion_page:([^:]+):([01])$/);
	if (selectedPage) {
		const dataSourceId = normalizeNotionPageId(selectedPage[1]);
		const selectedPageId = interaction.data?.values?.length === 1 ? normalizeNotionPageId(interaction.data.values[0]) : null;
		if (!dataSourceId || !selectedPageId) return interactionMessage('議事録の回を候補から選択してください。');
		ctx.waitUntil(showNotionPagePickerForSelection(interaction, dataSourceId, env, selectedPage[2] === '1', selectedPageId));
		return Response.json({ type: 6 });
	}
	switch (customId) {
		case 'meeting_stop':
			ctx.waitUntil(
				processCommand(
					{
						action: 'stop',
						guildId: componentContext.guildId,
						channelId: componentContext.channelId,
						notionParentPageId: null,
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
			ctx.waitUntil(showNotionDatabasePicker(interaction, env));
			return Response.json({ type: 6 });
		case 'meeting_select_saved_notion':
			ctx.waitUntil(showSavedNotionPagePicker(interaction, env, componentContext));
			return Response.json({ type: 6 });
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
	return { guildId, channelId };
}

async function showNotionDatabasePicker(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	selectedDatabaseId?: string,
	rememberOverride?: boolean,
): Promise<void> {
	if (!interaction.token) return;
	const componentContext = parseComponentContext(interaction);
	const rememberDefault =
		rememberOverride ??
		(componentContext
			? Boolean(
					await env.VOICE_CHANNEL_SESSION.getByName(
						`${componentContext.guildId}:${componentContext.channelId}`,
					).getDefaultNotionParentPageId(),
				)
			: false);
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
		const selectedDatabaseExists = selectedDatabaseId && databases.some((database) => database.id === selectedDatabaseId);
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionDatabasePickerMessage(
				databases,
				selectedDatabaseId && !selectedDatabaseExists ? '選択したデータベースが見つかりません。もう一度選択してください。' : undefined,
				selectedDatabaseExists ? selectedDatabaseId : null,
				rememberDefault,
			),
		);
	} catch (error) {
		console.error('[notion] database search failed', error instanceof Error ? error.name : 'unknown error');
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionDatabasePickerMessage([], 'Notion データベースを取得できませんでした。時間をおいて再試行してください。'),
		);
	}
}

async function showNotionPagePickerForSelection(
	interaction: DiscordInteraction,
	databaseId: string,
	env: WorkerEnv,
	rememberForVoiceChannel: boolean,
	selectedPageId?: string,
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
		await showNotionPagePicker(interaction, env, database, rememberForVoiceChannel, selectedPageId);
	} catch (error) {
		console.error('[notion] database selection failed', error instanceof Error ? error.name : 'unknown error');
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionDatabasePickerMessage([], 'データベースを取得できませんでした。時間をおいて再試行してください。'),
		);
	}
}

async function showNotionPagePicker(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	database: NotionDataSource,
	rememberForVoiceChannel: boolean,
	selectedPageId?: string,
): Promise<void> {
	if (!interaction.token) return;
	try {
		const pages = await queryNotionDataSource(env, database, '');
		const selectedPageExists = selectedPageId && pages.some((page) => page.pageId === selectedPageId);
		const notice =
			pages.length === 0
				? 'このデータベースに選択できるページがありません。Notion の共有設定を確認して再読み込みしてください。'
				: selectedPageId && !selectedPageExists
					? '選択したページが見つかりません。もう一度選択してください。'
					: undefined;
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionParentPagePickerMessage(
				database.title,
				pages,
				database.dataSourceId,
				notice,
				rememberForVoiceChannel,
				selectedPageExists ? selectedPageId : null,
			),
		);
	} catch (error) {
		console.error('[notion] database page query failed', error instanceof Error ? error.name : 'unknown error');
		await editOriginalResponse(
			env.DISCORD_APPLICATION_ID,
			interaction.token,
			notionParentPagePickerMessage(
				database.title,
				[],
				database.dataSourceId,
				'データベース内のページを取得できませんでした。時間をおいて再読み込みしてください。',
				rememberForVoiceChannel,
			),
		);
	}
}

async function showSavedNotionPagePicker(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	componentContext: ComponentContext,
): Promise<void> {
	const session = env.VOICE_CHANNEL_SESSION.getByName(`${componentContext.guildId}:${componentContext.channelId}`);
	const [notionParentPageId, dataSourceId] = await Promise.all([
		session.getDefaultNotionParentPageId(),
		session.getDefaultNotionDataSourceId(),
	]);
	if (!notionParentPageId) {
		await showMeetingMessage(interaction, env);
		return;
	}
	if (!dataSourceId) {
		await showNotionDatabasePicker(interaction, env, undefined, true);
		return;
	}
	await showNotionPagePickerForSelection(interaction, dataSourceId, env, true, notionParentPageId);
}

async function showMeetingMessage(interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
	if (!interaction.token) return;
	const componentContext = parseComponentContext(interaction);
	const session = componentContext
		? env.VOICE_CHANNEL_SESSION.getByName(`${componentContext.guildId}:${componentContext.channelId}`)
		: null;
	const [parentPageId, dataSourceId] = session
		? await Promise.all([session.getDefaultNotionParentPageId(), session.getDefaultNotionDataSourceId()])
		: [null, null];
	await editOriginalResponse(
		env.DISCORD_APPLICATION_ID,
		interaction.token,
		meetingMessage(undefined, Boolean(parentPageId && dataSourceId)),
	);
}

async function showDiscordOnlyUnavailableMessage(interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
	if (!interaction.token) return;
	await editOriginalResponse(env.DISCORD_APPLICATION_ID, interaction.token, discordOnlyUnavailableMessage());
}
