import type { WorkerEnv } from '../env.js';
import type { VoiceSession } from '../sessions/types.js';

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

export async function publishMeetingToNotion(env: WorkerEnv, session: VoiceSession): Promise<string> {
	if (!env.NOTION_API_TOKEN || !env.NOTION_DATA_SOURCE_ID) {
		throw new Error('Notion API token and data source ID are required');
	}

	const object = await env.RECORDINGS.get(session.manifestKey);
	if (!object) {
		throw new Error('Session manifest was not found in R2');
	}
	const manifest = parseManifest(await object.json<unknown>(), session.sessionId);
	const title = `会議 ${formatTimestamp(manifest.startedAt)} JST (${session.sessionId.slice(0, 8)})`;
	const markdown = [
		`# ${title}`,
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
		'## 文字起こし',
		'',
		manifest.transcription.text || '文字起こし結果はありません。',
	].join('\n');

	const response = await fetch('https://api.notion.com/v1/pages', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.NOTION_API_TOKEN}`,
			'Content-Type': 'application/json',
			'Notion-Version': NOTION_API_VERSION,
		},
		body: JSON.stringify({
			parent: { type: 'data_source_id', data_source_id: env.NOTION_DATA_SOURCE_ID },
			markdown,
		}),
	});
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const code = isRecord(body) && typeof body.code === 'string' ? ` (${body.code})` : '';
		throw new Error(`Notion API returned ${response.status}${code}`);
	}
	if (!isRecord(body)) {
		throw new Error('Notion API returned an invalid page response');
	}
	if (typeof body.url === 'string') {
		return body.url;
	}
	return typeof body.id === 'string' ? body.id : 'page URL unavailable';
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
