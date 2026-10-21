import { ButtonStyle, ComponentType, MessageFlags } from 'discord-api-types/v10';
import type {
	APIComponentInContainer,
	APIMessageTopLevelComponent,
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
				...(embed.title ? [{ type: ComponentType.TextDisplay as const, content: `## ${embed.title}` }] : []),
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

export function meetingMessage(notice?: string, useSavedNotionParentPage = false): RESTPatchAPIInteractionOriginalResponseJSONBody {
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [
			{
				type: ComponentType.Container,
				accent_color: 0x5865f2,
				components: [
					{
						type: ComponentType.TextDisplay as ComponentType.TextDisplay,
						content: '## 📝 議事録を作成する\nボイスチャットの会話を文字起こしし、AI が議事録にまとめます。',
					},
					...(notice ? [{ type: ComponentType.TextDisplay as const, content: `✅ ${notice}` }] : []),
					{ type: ComponentType.TextDisplay, content: '**議事録の保存先を選んでください。**' },
					{
						type: ComponentType.Section,
						components: [
							{
								type: ComponentType.TextDisplay,
								content: useSavedNotionParentPage
									? '**📖 Notion に保存**\n前回と同じデータベースの議事録一覧から選べます。'
									: '**📖 Notion に保存**\n議事録を Notion で整理・管理できます。\n会議ごとに保存先を選んで録音を開始します。',
							},
						],
						accessory: {
							type: ComponentType.Button,
							style: ButtonStyle.Primary,
							label: useSavedNotionParentPage ? '前回と同じ議事録一覧から選択' : 'Notion の設定へ →',
							custom_id: useSavedNotionParentPage ? 'meeting_select_saved_notion' : 'meeting_setup_notion',
						},
					},
					...(useSavedNotionParentPage
						? [
								{
									type: ComponentType.ActionRow as const,
									components: [
										{
											type: ComponentType.Button as const,
											style: ButtonStyle.Secondary,
											label: '保存先を変更',
											custom_id: 'meeting_setup_notion',
										},
									],
								},
							]
						: []),
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

export function discordOnlyUnavailableMessage(): RESTPatchAPIInteractionOriginalResponseJSONBody {
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [
			{
				type: ComponentType.Container,
				accent_color: 0x5865f2,
				components: [
					{ type: ComponentType.TextDisplay, content: '## この機能はまだサポートされていません。' },
					{
						type: ComponentType.Section,
						components: [{ type: ComponentType.TextDisplay, content: 'セットアップ画面に戻るには、こちらを押してください。' }],
						accessory: {
							type: ComponentType.Button,
							style: ButtonStyle.Secondary,
							label: '戻る',
							custom_id: 'meeting_setup_cancel',
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
	selectedDatabaseId?: string | null,
	rememberDefault = false,
): RESTPatchAPIInteractionOriginalResponseJSONBody {
	const components: APIComponentInContainer[] = [
		{ type: ComponentType.TextDisplay, content: '-# STEP 1 / 2' },
		{ type: ComponentType.TextDisplay, content: '# Notion の保存先を選択' },
		{ type: ComponentType.TextDisplay, content: '議事録を保存するデータベースを選んでください。' },
		...(notice ? [{ type: ComponentType.TextDisplay as const, content: `⚠️ ${notice}` }] : []),
	];
	if (databases.length > 0) {
		components.push({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.StringSelect,
					custom_id: `meeting_select_notion_database:${rememberDefault ? '1' : '0'}`,
					placeholder: 'Notion データベースを選択',
					options: databases.map((database) => ({
						label: formatNotionDataSourceLabel(database.parentTitle, database.title),
						value: database.id,
						...(database.id === selectedDatabaseId ? { default: true } : {}),
					})),
					min_values: 1,
					max_values: 1,
				},
			],
		});
		components.push({
			type: ComponentType.Section,
			components: [
				{
					type: ComponentType.TextDisplay,
					content: '**保存先を記憶**\nこのボイスチャットで次回も使用します。',
				},
			],
			accessory: {
				type: ComponentType.Button,
				style: rememberDefault ? ButtonStyle.Success : ButtonStyle.Secondary,
				label: rememberDefault ? 'ON' : 'OFF',
				custom_id: selectedDatabaseId
					? `meeting_toggle_notion_remember:${selectedDatabaseId}:${rememberDefault ? '0' : '1'}`
					: 'meeting_toggle_notion_remember',
				disabled: !selectedDatabaseId,
			},
		});
	}
	if (databases.length === 0 && !notice) {
		components.push({
			type: ComponentType.TextDisplay,
			content: 'Botに共有されているデータベースが見つかりませんでした。Notionの共有設定を確認して再試行してください。',
		});
	}
	if (databases.length === 0) {
		components.push({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.Button,
					style: ButtonStyle.Primary,
					label: '再試行',
					custom_id: 'meeting_setup_notion',
				},
			],
		});
	}
	components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
	components.push({
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Secondary,
				label: '戻る',
				custom_id: 'meeting_setup_cancel',
			},
			{
				type: ComponentType.Button,
				style: ButtonStyle.Primary,
				label: '次へ',
				custom_id: selectedDatabaseId
					? `meeting_next_notion_database:${selectedDatabaseId}:${rememberDefault ? '1' : '0'}`
					: 'meeting_next_notion_database',
				disabled: !selectedDatabaseId,
			},
		],
	});
	return {
		flags: MessageFlags.IsComponentsV2,
		components: [{ type: ComponentType.Container, accent_color: 0x5865f2, components }],
	};
}

export function notionParentPagePickerMessage(
	databaseTitle: string,
	pages: Array<{ pageId: string; title: string }>,
	dataSourceId: string,
	notice?: string,
	rememberForVoiceChannel = false,
	selectedPageId?: string | null,
): RESTPatchAPIInteractionOriginalResponseJSONBody {
	const components: APIComponentInContainer[] = [
		{ type: ComponentType.TextDisplay, content: '-# STEP 2 / 2' },
		{ type: ComponentType.TextDisplay, content: '# 録音する会議の親ページを選択' },
		{
			type: ComponentType.TextDisplay,
			content: `データベース: **${databaseTitle}**\n録音する会議の親ページを選んでください。`,
		},
		{
			type: ComponentType.TextDisplay,
			content: rememberForVoiceChannel
				? '**保存先を記憶: ON**\n選んだページを次回以降もこのボイスチャットで使用します。'
				: '**保存先を記憶: OFF**\n選んだページは今回のみ使用します。',
		},
	];
	if (notice) components.push({ type: ComponentType.TextDisplay, content: notice });
	if (pages.length > 0) {
		components.push({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.StringSelect,
					custom_id: `meeting_select_notion_page:${dataSourceId}:${rememberForVoiceChannel ? '1' : '0'}`,
					placeholder: '録音する会議の親ページを選択',
					options: pages.map((page) => ({
						label: page.title.slice(0, 100),
						value: page.pageId,
						...(page.pageId === selectedPageId ? { default: true } : {}),
					})),
					min_values: 1,
					max_values: 1,
				},
			],
		});
	}
	if (pages.length === 0) {
		components.push({
			type: ComponentType.ActionRow,
			components: [
				{
					type: ComponentType.Button,
					style: ButtonStyle.Primary,
					label: '再読み込み',
					custom_id: `meeting_retry_notion_pages:${dataSourceId}:${rememberForVoiceChannel ? '1' : '0'}`,
				},
			],
		});
	}
	components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
	components.push({
		type: ComponentType.ActionRow,
		components: [
			{
				type: ComponentType.Button,
				style: ButtonStyle.Secondary,
				label: '戻る',
				custom_id: `meeting_back_notion_page:${dataSourceId}:${rememberForVoiceChannel ? '1' : '0'}`,
			},
			{
				type: ComponentType.Button,
				style: ButtonStyle.Primary,
				label: '次へ',
				custom_id: selectedPageId
					? `meeting_next_notion_page:${dataSourceId}:${selectedPageId}:${rememberForVoiceChannel ? '1' : '0'}`
					: 'meeting_next_notion_page',
				disabled: !selectedPageId,
			},
		],
	});
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

export function recordingMessageWithoutStopButton(message: {
	components?: APIMessageTopLevelComponent[];
}): RESTPatchAPIInteractionOriginalResponseJSONBody {
	const components = (message.components ?? []).flatMap((component): APIMessageTopLevelComponent[] => {
		if (component.type === ComponentType.ActionRow) {
			const buttons = component.components.filter(
				(child) => child.type !== ComponentType.Button || !('custom_id' in child) || child.custom_id !== 'meeting_stop',
			);
			return buttons.length > 0 ? [{ ...component, components: buttons }] : [];
		}
		if (component.type === ComponentType.Container) {
			const children = component.components.flatMap((child): APIComponentInContainer[] => {
				if (child.type !== ComponentType.ActionRow) return [child];
				const buttons = child.components.filter(
					(button) => button.type !== ComponentType.Button || !('custom_id' in button) || button.custom_id !== 'meeting_stop',
				);
				return buttons.length > 0 ? [{ ...child, components: buttons }] : [];
			});
			return [{ ...component, components: children }];
		}
		return [component];
	});
	return { components };
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
