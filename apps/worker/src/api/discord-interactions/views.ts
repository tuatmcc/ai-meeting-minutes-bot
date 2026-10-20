import { ButtonStyle, ComponentType, MessageFlags, SeparatorSpacingSize } from 'discord-api-types/v10';
import type {
	APIComponentInContainer,
	APIComponentInMessageActionRow,
	APIEmbed,
	RESTPatchAPIInteractionOriginalResponseJSONBody,
} from 'discord-api-types/v10';
import type { VoiceSession } from '../../sessions/types.js';
import type { CommandMessage } from './types.js';

export function commandMessageAsComponentsV2(message: CommandMessage): RESTPatchAPIInteractionOriginalResponseJSONBody {
	const embed = typeof message === 'string' ? undefined : message.embeds?.[0];
	const actionRows =
		typeof message === 'string' ? [] : (message.components ?? []).filter((component) => component.type === ComponentType.ActionRow);
	const components = embed
		? [
				...(embed.title ? [{ type: ComponentType.TextDisplay as const, content: `# ${embed.title}` }] : []),
				...(embed.description ? [{ type: ComponentType.TextDisplay as const, content: embed.description }] : []),
				...(embed.fields ?? []).map((field) => ({
					type: ComponentType.TextDisplay as const,
					content: `**${field.name}**\n${field.value}`,
				})),
				...actionRows,
			]
		: [{ type: ComponentType.TextDisplay as const, content: typeof message === 'string' ? message : '録音を開始しました。' }];
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [{ type: ComponentType.Container, accent_color: 0x5865f2, components }],
	};
}

export function meetingMessage(
	channelId: string,
	database: { title: string } | null,
	notice?: string,
): RESTPatchAPIInteractionOriginalResponseJSONBody {
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [
			{
				type: ComponentType.Container,
				accent_color: 0x5865f2,
				components: [
					{
						type: ComponentType.TextDisplay as ComponentType.TextDisplay,
						content: '# 議事録 Bot へようこそ\nこの Bot は Discord の会話を文字起こしして、自動で議事録を作成します。',
					},
					...(notice ? [{ type: ComponentType.TextDisplay as const, content: `✅ ${notice}` }] : []),
					{
						type: ComponentType.TextDisplay,
						content: `**現在の VC**\n<#${channelId}>\n\n**保存先**\n${database ? `Notion: ${database.title}` : 'まだ設定されていません。どのように利用しますか？'}`,
					},
					{ type: ComponentType.Separator, spacing: SeparatorSpacingSize.Small },
					{
						type: ComponentType.Section,
						components: [
							{
								type: ComponentType.TextDisplay,
								content: '**Notion に議事録を保存**\n保存先のデータベースを選ぶと、会議ごとの議事録を自動作成します。',
							},
						],
						accessory: {
							type: ComponentType.Button,
							style: ButtonStyle.Secondary,
							label: 'Notion に議事録を保存',
							custom_id: 'meeting_setup_notion',
							emoji: { name: '📖' },
						},
					},
					{
						type: ComponentType.Section,
						components: [
							{
								type: ComponentType.TextDisplay,
								content: '**Discord だけで使う**\n議事録を Discord に投稿します。Notion は後から連携できます。',
							},
						],
						accessory: {
							type: ComponentType.Button,
							style: ButtonStyle.Secondary,
							label: 'Discord だけで使う',
							custom_id: 'meeting_setup_discord',
							emoji: { name: '💬' },
						},
					},
				],
			},
		],
	};
}

export function notionDatabasePickerMessage(
	databases: Array<{ id: string; title: string; parentTitle: string | null }>,
	notice?: string,
): RESTPatchAPIInteractionOriginalResponseJSONBody {
	const components: APIComponentInContainer[] = [
		{ type: ComponentType.TextDisplay, content: '# Notion の保存先を選択' },
		{ type: ComponentType.TextDisplay, content: notice ?? '議事録を保存するデータベースを選んでください。' },
	];
	if (databases.length > 0) {
		components.push({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.StringSelect,
					custom_id: 'meeting_select_notion_database',
					placeholder: 'Notion データベースを選択',
					options: databases.map((database) => ({
						label: formatNotionDataSourceLabel(database.parentTitle, database.title),
						value: database.id,
					})),
					min_values: 1,
					max_values: 1,
				},
			],
		});
	} else if (!notice) {
		components.push({
			type: ComponentType.TextDisplay,
			content: 'Botに共有されているデータベースが見つかりませんでした。Notionの共有設定を確認して再試行してください。',
		});
	}
	const buttons: APIComponentInMessageActionRow[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: '戻る',
			custom_id: 'meeting_setup_cancel',
		},
	];
	if (databases.length === 0) {
		buttons.push({
			type: ComponentType.Button,
			style: ButtonStyle.Primary,
			label: '再試行',
			custom_id: 'meeting_setup_notion',
		});
	}
	components.push({ type: ComponentType.ActionRow, components: buttons });
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [{ type: ComponentType.Container, accent_color: 0x5865f2, components }],
	};
}

export function notionParentPagePickerMessage(
	databaseTitle: string,
	pages: Array<{ pageId: string; title: string }>,
	notice?: string,
): RESTPatchAPIInteractionOriginalResponseJSONBody {
	const components: APIComponentInContainer[] = [
		{ type: ComponentType.TextDisplay, content: '# 録音する会議の親ページを選択' },
		{
			type: ComponentType.TextDisplay,
			content: `データベース: **${databaseTitle}**\n選んだページの下に AI 議事録を作成し、録音を開始します。`,
		},
	];
	if (notice) components.push({ type: ComponentType.TextDisplay, content: notice });
	if (pages.length > 0) {
		components.push({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.StringSelect,
					custom_id: 'meeting_select_notion_page',
					placeholder: '録音する会議の親ページを選択',
					options: pages.map((page) => ({ label: page.title.slice(0, 100), value: page.pageId })),
					min_values: 1,
					max_values: 1,
				},
			],
		});
	}
	const buttons: APIComponentInMessageActionRow[] = [
		{
			type: ComponentType.Button,
			style: ButtonStyle.Secondary,
			label: '戻る',
			custom_id: 'meeting_setup_cancel',
		},
	];
	if (pages.length === 0) {
		buttons.push({
			type: ComponentType.Button,
			style: ButtonStyle.Primary,
			label: '再読み込み',
			custom_id: 'meeting_retry_notion_pages',
		});
	}
	components.push({ type: ComponentType.ActionRow, components: buttons });
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [{ type: ComponentType.Container, accent_color: 0x5865f2, components }],
	};
}

export function recordingEmbed(
	title: string,
	description: string,
	session: Pick<VoiceSession, 'notionParentPageId' | 'notionPageId' | 'notionPageUrl'>,
	notionPageCreationFailed: boolean,
): APIEmbed {
	const fields: NonNullable<APIEmbed['fields']> = [];
	if (session.notionParentPageId) {
		fields.push({ name: '対象の議事録', value: `[Notionで開く](${notionUrl(session.notionParentPageId)})` });
	}
	const aiPageUrl = session.notionPageUrl ?? (session.notionPageId ? notionUrl(session.notionPageId) : null);
	fields.push({
		name: '生成されたAI議事録',
		value: aiPageUrl
			? `[Notionで開く](${aiPageUrl})`
			: notionPageCreationFailed
				? 'ページの作成に失敗しました。録音終了後に再試行します。'
				: '生成されたAI議事録ページは未作成です。',
	});
	return { title, description, color: 0x5865f2, fields };
}

export function recordingMessage(
	title: string,
	description: string,
	session: Pick<VoiceSession, 'notionParentPageId' | 'notionPageId' | 'notionPageUrl'>,
	notionPageCreationFailed: boolean,
): RESTPatchAPIInteractionOriginalResponseJSONBody {
	return {
		embeds: [recordingEmbed(title, description, session, notionPageCreationFailed)],
		components: [
			{
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.Button,
						style: ButtonStyle.Danger,
						label: '録音を終了',
						custom_id: 'meeting_stop',
					},
				],
			},
		],
	};
}

export function formatSessionStatus(session: VoiceSession, gatewayStatus: 'connected' | 'disconnected'): string {
	const state = {
		starting: '開始処理中',
		recording: '録音中',
		processing: '文字起こし処理中',
		completed: '完了',
		failed: '失敗',
	}[session.state];
	const notionStatus = {
		not_requested: '対象外',
		unknown: '状態不明',
		pending: '作成待ち',
		creating: '作成中',
		created: '更新待ち',
		queued: '保存待ち',
		publishing: '保存中',
		retrying: '再試行待ち',
		published: '保存済み',
		failed: '保存失敗',
	}[session.notionPageStatus];
	const lines = [
		`録音状態: ${state}`,
		`Gateway: ${gatewayStatus === 'connected' ? '接続中' : '未接続'}`,
		`開始: <t:${Math.floor(Date.parse(session.createdAt) / 1000)}:f>`,
		`Notion: ${notionStatus}`,
	];
	if (session.durationMs !== null) lines.push(`録音時間: ${Math.floor(session.durationMs / 60_000)}分`);
	if (session.notionPageUrl) lines.push(`議事録: <${session.notionPageUrl}>`);
	return lines.join('\n');
}

export function sessionStateMessage(session: VoiceSession, channelId: string): string {
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

export function formatNotionDataSourceLabel(parentTitle: string | null, title: string): string {
	const databaseTitle = title.slice(0, 100);
	if (!parentTitle) return databaseTitle;
	const parentPrefixLength = 100 - databaseTitle.length - 3;
	if (parentPrefixLength < 1) return databaseTitle;
	return `${parentTitle.slice(0, parentPrefixLength)} / ${databaseTitle}`;
}

function notionUrl(pageId: string): string {
	return `https://www.notion.so/${pageId.replaceAll('-', '')}`;
}
