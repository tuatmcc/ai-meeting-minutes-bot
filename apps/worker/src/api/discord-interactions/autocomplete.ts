import type { WorkerEnv } from '../../env.js';
import { queryNotionDataSource, searchNotionDataSources } from '../../notion/meeting-pages.js';
import { formatNotionDataSourceLabel } from './views.js';
import { SNOWFLAKE_PATTERN } from './protocol.js';
import type { DiscordInteraction } from './types.js';

export async function handleAutocomplete(interaction: DiscordInteraction, env: WorkerEnv): Promise<Response> {
	const data = interaction.data;
	const option = data?.options?.find((item) => item.focused);
	const isDatabaseCommand = data?.name === 'meeting_link_notion_db';
	const permissions = interaction.member?.permissions;
	const canManageGuild = permissions !== undefined && /^\d+$/.test(permissions) && (BigInt(permissions) & 40n) !== 0n;
	if (
		!interaction.guild_id ||
		!SNOWFLAKE_PATTERN.test(interaction.guild_id) ||
		!interaction.channel_id ||
		!SNOWFLAKE_PATTERN.test(interaction.channel_id) ||
		(data?.name !== 'meeting_start' && !isDatabaseCommand) ||
		(isDatabaseCommand && !canManageGuild) ||
		!option ||
		option.name !== (isDatabaseCommand ? 'database' : 'meeting')
	) {
		return Response.json({ type: 8, data: { choices: [] } });
	}

	const query = typeof option.value === 'string' ? option.value.slice(0, 100) : '';
	try {
		let choices: Array<{ name: string; value: string }>;
		if (isDatabaseCommand) {
			choices = (await searchNotionDataSources(env, query)).map((database) => ({
				name: formatNotionDataSourceLabel(database.parentTitle, database.title),
				value: database.id,
			}));
		} else {
			const session = env.VOICE_CHANNEL_SESSION.getByName(`${interaction.guild_id}:${interaction.channel_id}`);
			const database = await session.getNotionDatabase();
			choices = database
				? (await queryNotionDataSource(env, database, query)).map((page) => ({ name: page.title.slice(0, 100), value: page.pageId }))
				: [];
		}
		return Response.json({ type: 8, data: { choices } });
	} catch (error) {
		console.error('[notion] page search failed', error instanceof Error ? error.name : 'unknown error');
		return Response.json({ type: 8, data: { choices: [] } });
	}
}
