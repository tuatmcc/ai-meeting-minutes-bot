/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../env.js';
import type { VoiceSession } from '../sessions/types.js';
import { publishMeetingToNotion } from './publish-meeting.js';

const { summarize } = vi.hoisted(() => ({ summarize: vi.fn() }));
vi.mock('../ai/summaries.js', () => ({ summarizeMeetingMinutes: summarize }));

const workerEnv = env as WorkerEnv;
let manifestKey: string;
let session: VoiceSession;

beforeEach(() => {
	const sessionId = `test-session-${crypto.randomUUID()}`;
	manifestKey = `meetings/${sessionId}/manifest.json`;
	session = {
		sessionId,
		guildId: 'guild',
		channelId: 'channel',
		state: 'completed',
		createdAt: '2026-01-01T00:00:00Z',
		startedAt: null,
		endedAt: null,
		manifestKey,
		notionParentPageId: null,
		notionPageId: 'page-id',
		notionPageUrl: null,
		notionPageStatus: 'publishing',
		notionAttemptCount: 0,
		notionLastError: null,
		notionNextAttemptAt: null,
		durationMs: 1000,
		manifestSizeBytes: null,
		errorCode: null,
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	summarize.mockReset();
});

describe('publishMeetingToNotion', () => {
	it('reuses generated markdown after a Notion failure', async () => {
		const manifest = createManifest('first transcript');
		await workerEnv.RECORDINGS.put(manifestKey, JSON.stringify(manifest));
		summarize.mockResolvedValue('generated summary');
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ code: 'internal_error' }, { status: 500 }))
			.mockResolvedValue(Response.json({}));
		vi.stubGlobal('fetch', fetchMock);
		const withToken = { ...workerEnv, NOTION_API_TOKEN: 'token' };

		await expect(publishMeetingToNotion(withToken, session)).rejects.toThrow('Notion API returned 500');
		await publishMeetingToNotion(withToken, session);

		expect(summarize).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).replace_content.new_str).toContain('generated summary');
	});

	it('generates new markdown when the manifest content changes', async () => {
		await workerEnv.RECORDINGS.put(manifestKey, JSON.stringify(createManifest('first transcript')));
		summarize.mockResolvedValueOnce('summary one').mockResolvedValueOnce('summary two');
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(() => Promise.resolve(Response.json({}))),
		);
		const withToken = { ...workerEnv, NOTION_API_TOKEN: 'token' };

		await publishMeetingToNotion(withToken, session);
		await workerEnv.RECORDINGS.put(manifestKey, JSON.stringify(createManifest('updated transcript')));
		await publishMeetingToNotion(withToken, session);

		expect(summarize).toHaveBeenCalledTimes(2);
	});

	it('keeps the full transcript when summary generation fails', async () => {
		const transcript = '全文の文字起こしを保持する。';
		await workerEnv.RECORDINGS.put(manifestKey, JSON.stringify(createManifest(transcript)));
		summarize.mockRejectedValue(new Error('AI unavailable'));
		const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
		vi.stubGlobal('fetch', fetchMock);

		await publishMeetingToNotion({ ...workerEnv, NOTION_API_TOKEN: 'token' }, session);

		const markdown = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).replace_content.new_str as string;
		expect(markdown).toContain('要約を生成できませんでした。文字起こしを参照してください。');
		expect(markdown).toContain(transcript);
	});
});

function createManifest(text: string) {
	return {
		sessionId: session.sessionId,
		startedAt: '2026-01-01T00:00:00Z',
		endedAt: '2026-01-01T00:01:00Z',
		durationMs: 60_000,
		transcription: { model: 'test-model', language: 'ja', text },
	};
}
