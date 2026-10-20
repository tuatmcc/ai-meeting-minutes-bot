import { summarizeMeetingMinutes } from '../ai/summaries.js';
import type { WorkerEnv } from '../env.js';
import { updateMeetingPageMarkdown } from '../notion/meeting-pages.js';
import type { VoiceSession } from '../sessions/types.js';

type MeetingManifest = {
	sessionId: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	transcription: { model: string; language: string | null; text: string };
};

const SUMMARY_FAILURE = '要約を生成できませんでした。文字起こしを参照してください。';

export async function publishMeetingToNotion(env: WorkerEnv, session: VoiceSession): Promise<void> {
	if (!env.NOTION_API_TOKEN || !session.notionPageId) throw new Error('Notion API token and page ID are required');
	const manifestObject = await env.RECORDINGS.get(session.manifestKey);
	if (!manifestObject) throw new Error('Session manifest was not found in R2');
	const rawManifest = await manifestObject.text();
	const digest = await sha256(rawManifest);
	const manifest = parseManifest(JSON.parse(rawManifest) as unknown, session.sessionId);
	const cacheKey = `meeting-minutes/${encodeURIComponent(session.sessionId)}/${digest}.json`;
	const cached = await env.RECORDINGS.get(cacheKey);
	let markdown: string;
	if (cached) {
		const value: unknown = await cached.json();
		markdown = isRecord(value) && value.digest === digest && typeof value.markdown === 'string' ? value.markdown : '';
	} else {
		markdown = '';
	}
	if (!markdown) {
		let summary: string;
		try {
			summary = await summarizeMeetingMinutes(env, manifest.transcription.text);
		} catch (error) {
			console.error('[notion] AI summary generation failed', error instanceof Error ? error.name : 'unknown error');
			summary = SUMMARY_FAILURE;
		}
		markdown = formatMinutes(session, manifest, summary);
		await env.RECORDINGS.put(cacheKey, JSON.stringify({ digest, markdown }), {
			httpMetadata: { contentType: 'application/json' },
		});
	}
	await updateMeetingPageMarkdown(env, session.notionPageId, markdown);
}

function parseManifest(value: unknown, sessionId: string): MeetingManifest {
	if (!isRecord(value) || value.sessionId !== sessionId) throw new Error('Session manifest does not match the completed session');
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
		transcription: { model: transcription.model, language: transcription.language, text: transcription.text },
	};
}

function formatMinutes(session: VoiceSession, manifest: MeetingManifest, summary: string): string {
	return [
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
		`- 文字起こしモデル: ${manifest.transcription.model}`,
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
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
