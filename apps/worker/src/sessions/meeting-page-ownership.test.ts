/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMeetingPage = vi.hoisted(() => vi.fn());
const publishMeetingToNotion = vi.hoisted(() => vi.fn());

vi.mock('../notion/meeting-pages.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../notion/meeting-pages.js')>();
	return { ...original, createMeetingPage };
});

vi.mock('../meetings/publish-meeting.js', () => ({ publishMeetingToNotion }));

describe('Notion meeting page ownership', () => {
	beforeEach(() => {
		createMeetingPage.mockReset();
		publishMeetingToNotion.mockReset();
	});

	it('retries a failed creation and reuses the page through the session owner', async () => {
		const channelId = crypto.randomUUID();
		const session = env.VOICE_CHANNEL_SESSION.getByName(`ownership:${channelId}`);
		const started = await session.startSession('guild', channelId, crypto.randomUUID(), 'parent-page');
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		createMeetingPage.mockRejectedValueOnce(new Error('temporary Notion failure'));
		const failed = await session.ensureMeetingPage(started.session.sessionId);
		expect(failed.ok && failed.session.notionPageStatus).toBe('failed');
		expect((await session.getLatestSession())?.notionLastError).toBe('temporary Notion failure');

		createMeetingPage.mockResolvedValue({ pageId: 'meeting-page', pageUrl: 'https://notion.test/meeting-page' });
		const retried = await session.ensureMeetingPage(started.session.sessionId);
		expect(retried.ok && retried.session.notionPageId).toBe('meeting-page');
		expect(retried.ok && retried.session.notionPageStatus).toBe('created');

		const reused = await session.ensureMeetingPage(started.session.sessionId);
		expect(reused).toEqual(retried);
		expect(createMeetingPage).toHaveBeenCalledTimes(2);
	});

	it('coalesces simultaneous creation for two channels sharing one parent page', async () => {
		const channelA = crypto.randomUUID();
		const channelB = crypto.randomUUID();
		const sessionA = env.VOICE_CHANNEL_SESSION.getByName(`ownership:${channelA}`);
		const sessionB = env.VOICE_CHANNEL_SESSION.getByName(`ownership:${channelB}`);
		const startedA = await sessionA.startSession('guild', channelA, crypto.randomUUID(), 'shared-parent');
		const startedB = await sessionB.startSession('guild', channelB, crypto.randomUUID(), 'shared-parent');
		expect(startedA.ok && startedB.ok).toBe(true);
		if (!startedA.ok || !startedB.ok) return;

		let resolvePage!: (page: { pageId: string; pageUrl: string }) => void;
		createMeetingPage.mockReturnValue(
			new Promise((resolve) => {
				resolvePage = resolve;
			}),
		);
		const ensuringA = sessionA.ensureMeetingPage(startedA.session.sessionId);
		const ensuringB = sessionB.ensureMeetingPage(startedB.session.sessionId);
		await vi.waitFor(() => expect(createMeetingPage).toHaveBeenCalledTimes(1));
		resolvePage({ pageId: 'shared-meeting-page', pageUrl: 'https://notion.test/shared-meeting-page' });
		const [resultA, resultB] = await Promise.all([ensuringA, ensuringB]);

		expect(resultA.ok && resultA.session.notionPageId).toBe('shared-meeting-page');
		expect(resultB.ok && resultB.session.notionPageId).toBe('shared-meeting-page');
		expect(createMeetingPage).toHaveBeenCalledTimes(1);
	});

	it('keeps the queued export state when initial page creation finishes after the session', async () => {
		const channelId = crypto.randomUUID();
		const session = env.VOICE_CHANNEL_SESSION.getByName(`ownership:${channelId}`);
		const started = await session.startSession('guild', channelId, crypto.randomUUID(), 'completion-race-parent');
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		let resolvePage!: (page: { pageId: string; pageUrl: string }) => void;
		createMeetingPage.mockReturnValue(
			new Promise((resolve) => {
				resolvePage = resolve;
			}),
		);
		const ensuring = session.ensureMeetingPage(started.session.sessionId);
		await vi.waitFor(() => expect(createMeetingPage).toHaveBeenCalledTimes(1));
		await session.markRecordingStarted(started.session.sessionId);
		await session.markProcessingStarted(started.session.sessionId);
		const completed = await session.completeSession(started.session.sessionId, {
			endedAt: new Date().toISOString(),
			durationMs: 1_000,
			manifestSizeBytes: 1,
		});
		expect(completed.ok && completed.session.notionPageStatus).toBe('queued');

		resolvePage({ pageId: 'late-meeting-page', pageUrl: 'https://notion.test/late-meeting-page' });
		const ensured = await ensuring;
		expect(ensured.ok && ensured.session.notionPageId).toBe('late-meeting-page');
		expect(ensured.ok && ensured.session.notionPageStatus).toBe('queued');
	});
});
