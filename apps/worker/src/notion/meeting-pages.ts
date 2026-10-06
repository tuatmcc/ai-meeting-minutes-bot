import type { WorkerEnv } from '../env.js';
import type { VoiceSession } from '../sessions/types.js';
import { summarizeMeetingMinutes } from '../ai/summaries.js';

const NOTION_API_VERSION = '2026-03-11';

type MeetingManifest = {
	sessionId: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	transcription: {
		model: string;
		language: string | null;
		text: string;
	};
};

export type CreatedMeetingPage = {
	pageId: string;
	pageUrl: string | null;
};

export type NotionPageChoice = {
	pageId: string;
	pageUrl: string | null;
	title: string;
};

export type NotionDataSource = {
	dataSourceId: string;
	title: string;
	titleProperty: string;
};

export async function searchNotionDataSources(env: WorkerEnv, query: string): Promise<Array<{ id: string; title: string }>> {
	if (!env.NOTION_API_TOKEN) return [];
	const response = await fetch('https://api.notion.com/v1/search', {
		method: 'POST',
		headers: notionHeaders(env.NOTION_API_TOKEN),
		body: JSON.stringify({
			query,
			page_size: 25,
			sort: { direction: 'descending', timestamp: 'last_edited_time' },
			filter: { property: 'object', value: 'data_source' },
		}),
	});
	const body = await readNotionResponse(response);
	if (!Array.isArray(body.results)) return [];
	return body.results.flatMap((result): Array<{ id: string; title: string }> => {
		if (typeof result !== 'object' || result === null || !('id' in result) || typeof result.id !== 'string') return [];
		const title = readRichTextTitle('title' in result ? result.title : undefined);
		return title ? [{ id: result.id, title }] : [];
	});
}

export async function getNotionDataSource(env: WorkerEnv, dataSourceId: string): Promise<NotionDataSource | null> {
	if (!env.NOTION_API_TOKEN) return null;
	const response = await fetch(`https://api.notion.com/v1/data_sources/${encodeURIComponent(dataSourceId)}`, {
		headers: notionHeaders(env.NOTION_API_TOKEN),
	});
	const body = await readNotionResponse(response);
	if (typeof body.id !== 'string' || !('properties' in body) || typeof body.properties !== 'object' || body.properties === null)
		return null;
	const titleProperty = Object.entries(body.properties).find(
		([, property]) => typeof property === 'object' && property !== null && 'type' in property && property.type === 'title',
	);
	const title = readRichTextTitle('title' in body ? body.title : undefined);
	return title && titleProperty ? { dataSourceId: body.id, title, titleProperty: titleProperty[0] } : null;
}

export async function queryNotionDataSource(env: WorkerEnv, database: NotionDataSource, query: string): Promise<NotionPageChoice[]> {
	if (!env.NOTION_API_TOKEN) return [];
	const titleFilter = query ? { property: database.titleProperty, title: { contains: query } } : undefined;
	const response = await fetch(`https://api.notion.com/v1/data_sources/${encodeURIComponent(database.dataSourceId)}/query`, {
		method: 'POST',
		headers: notionHeaders(env.NOTION_API_TOKEN),
		body: JSON.stringify({
			page_size: 25,
			sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
			...(titleFilter ? { filter: titleFilter } : {}),
		}),
	});
	const body = await readNotionResponse(response);
	if (!Array.isArray(body.results)) return [];
	return body.results.flatMap((result) => parseNotionPageChoice(result) ?? []);
}

function parseNotionPageChoice(value: unknown): NotionPageChoice | null {
	if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') return null;
	const properties =
		'properties' in value && typeof value.properties === 'object' && value.properties !== null ? Object.values(value.properties) : [];
	const titleProperty = properties.find(
		(property) => typeof property === 'object' && property !== null && 'type' in property && property.type === 'title',
	);
	const titleItems: unknown[] =
		titleProperty && typeof titleProperty === 'object' && 'title' in titleProperty && Array.isArray(titleProperty.title)
			? titleProperty.title
			: [];
	const title = titleItems
		.map((item) =>
			typeof item === 'object' && item !== null && 'plain_text' in item && typeof item.plain_text === 'string' ? item.plain_text : '',
		)
		.join('')
		.trim();
	if (!title) return null;
	return {
		pageId: value.id,
		pageUrl: 'url' in value && typeof value.url === 'string' ? value.url : null,
		title,
	};
}

function readRichTextTitle(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const title = value
		.map((item) =>
			typeof item === 'object' && item !== null && 'plain_text' in item && typeof item.plain_text === 'string' ? item.plain_text : '',
		)
		.join('')
		.trim();
	return title || null;
}

export async function createMeetingPage(env: WorkerEnv, session: VoiceSession): Promise<CreatedMeetingPage> {
	if (!env.NOTION_API_TOKEN || !session.notionParentPageId) {
		throw new Error('Notion API token and parent page ID are required');
	}

	const response = await fetch('https://api.notion.com/v1/pages', {
		method: 'POST',
		headers: notionHeaders(env.NOTION_API_TOKEN),
		body: JSON.stringify({
			parent: { page_id: session.notionParentPageId },
			markdown: [
				'# AI議事録',
				'',
				'## 会議情報',
				'',
				`- セッションID: ${session.sessionId}`,
				`- Guild ID: ${session.guildId}`,
				`- Voice Channel ID: ${session.channelId}`,
				`- 開始要求: ${formatTimestamp(session.createdAt)} JST`,
				'',
				'録音終了後に要約と文字起こしを追加します。',
			].join('\n'),
		}),
	});
	const body = await readNotionResponse(response);
	if (typeof body.id !== 'string') {
		throw new Error('Notion API returned a page without an ID');
	}
	return {
		pageId: body.id,
		pageUrl: typeof body.url === 'string' ? body.url : null,
	};
}

export async function publishMeetingToNotion(env: WorkerEnv, session: VoiceSession): Promise<void> {
	if (!env.NOTION_API_TOKEN || !session.notionPageId) {
		throw new Error('Notion API token and page ID are required');
	}

	const object = await env.RECORDINGS.get(session.manifestKey);
	if (!object) {
		throw new Error('Session manifest was not found in R2');
	}
	const manifest = parseManifest(await object.json<unknown>(), session.sessionId);
	let summary: string;
	try {
		summary = await summarizeMeetingMinutes(env, manifest.transcription.text);
	} catch (error) {
		console.error('[notion] AI summary generation failed', error instanceof Error ? error.name : 'unknown error');
		summary = '要約を生成できませんでした。文字起こしを参照してください。';
	}
	const markdown = [
		'# AI議事録',
		'',
		'## 会議情報',
		'',
		`- セッションID: ${session.sessionId}`,
		`- Guild ID: ${session.guildId}`,
		`- Voice Channel ID: ${session.channelId}`,
		`- 開始: ${formatTimestamp(manifest.startedAt)} JST`,
		`- 終了: ${formatTimestamp(manifest.endedAt)} JST`,
		`- 録音時間: ${formatDuration(manifest.durationMs)}`,
		`- ASRモデル: ${manifest.transcription.model}`,
		`- 言語: ${manifest.transcription.language ?? '不明'}`,
		'',
		'## 要約',
		'',
		summary,
		'',
		'## 文字起こし',
		'',
		manifest.transcription.text || '文字起こし結果はありません。',
	].join('\n');

	const response = await fetch(`https://api.notion.com/v1/pages/${session.notionPageId}/markdown`, {
		method: 'PATCH',
		headers: notionHeaders(env.NOTION_API_TOKEN),
		body: JSON.stringify({ type: 'replace_content', replace_content: { new_str: markdown } }),
	});
	await readNotionResponse(response);
}

export async function markMeetingPageFailed(env: WorkerEnv, session: VoiceSession, errorCode: string): Promise<void> {
	if (!env.NOTION_API_TOKEN || !session.notionPageId) {
		return;
	}

	const response = await fetch(`https://api.notion.com/v1/pages/${session.notionPageId}/markdown`, {
		method: 'PATCH',
		headers: notionHeaders(env.NOTION_API_TOKEN),
		body: JSON.stringify({
			type: 'replace_content',
			replace_content: {
				new_str: [
					'# AI議事録',
					'',
					'録音または文字起こしの処理に失敗しました。',
					'',
					`- セッションID: ${session.sessionId}`,
					`- エラーコード: ${errorCode}`,
				].join('\n'),
			},
		}),
	});
	await readNotionResponse(response);
}

function notionHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
		'Notion-Version': NOTION_API_VERSION,
	};
}

async function readNotionResponse(response: Response): Promise<Record<string, unknown>> {
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const code = isRecord(body) && typeof body.code === 'string' ? ` (${body.code})` : '';
		throw new Error(`Notion API returned ${response.status}${code}`);
	}
	if (!isRecord(body)) {
		throw new Error('Notion API returned an invalid response');
	}
	return body;
}

function parseManifest(value: unknown, sessionId: string): MeetingManifest {
	if (!isRecord(value) || value.sessionId !== sessionId) {
		throw new Error('Session manifest does not match the completed session');
	}
	const transcription = value.transcription;
	if (
		typeof value.startedAt !== 'string' ||
		!Number.isFinite(Date.parse(value.startedAt)) ||
		typeof value.endedAt !== 'string' ||
		!Number.isFinite(Date.parse(value.endedAt)) ||
		typeof value.durationMs !== 'number' ||
		!Number.isFinite(value.durationMs) ||
		!isRecord(transcription) ||
		typeof transcription.model !== 'string' ||
		!(transcription.language === null || typeof transcription.language === 'string') ||
		typeof transcription.text !== 'string'
	) {
		throw new Error('Session manifest is missing required meeting or transcription data');
	}

	return {
		sessionId,
		startedAt: value.startedAt,
		endedAt: value.endedAt,
		durationMs: value.durationMs,
		transcription: {
			model: transcription.model,
			language: transcription.language,
			text: transcription.text,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function formatTimestamp(value: string): string {
	return new Intl.DateTimeFormat('ja-JP', {
		timeZone: 'Asia/Tokyo',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(new Date(value));
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.floor(durationMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}時間${minutes}分${seconds}秒` : `${minutes}分${seconds}秒`;
}
