/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import type { WorkerEnv } from '../env.js';
import { handleSessionApi } from '../api/session-api.js';
import { MAX_AUDIO_BYTES, TRANSCRIPTION_MODEL } from './transcription.js';

const guildId = '12345678901234567';
const speakerId = '22345678901234567';

function wav(durationMs = 1000): ArrayBuffer {
	const buffer = new ArrayBuffer(44 + durationMs * 32);
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
	tag(0, 'RIFF');
	view.setUint32(4, buffer.byteLength - 8, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16_000, true);
	view.setUint32(28, 32_000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, 'data');
	view.setUint32(40, buffer.byteLength - 44, true);
	return buffer;
}

async function setup(state = 'recording') {
	const channelId = String(BigInt(guildId) + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]));
	const stub = env.VOICE_CHANNEL_SESSION.getByName(`${guildId}:${channelId}`);
	const started = await stub.startSession(guildId, channelId, crypto.randomUUID());
	if (!started.ok) throw new Error('Session setup failed');
	const sessionId = started.session.sessionId;
	if (state !== 'starting') await stub.markRecordingStarted(sessionId);
	if (state === 'processing') await stub.markProcessingStarted(sessionId);
	if (state === 'failed') await stub.failSession(sessionId, 'test_failure');
	const key = `guilds/${guildId}/voice-channels/${channelId}/sessions/${sessionId}/chunks/0.wav`;
	const url = `https://example.com/api/v1/guilds/${guildId}/voice-channels/${channelId}/sessions/${sessionId}/transcribe`;
	const send = (body = wav(), overrides: Record<string, string> = {}) =>
		handleSessionApi(
			new Request(url, {
				method: 'POST',
				body,
				headers: {
					Authorization: 'Bearer test-token',
					'Content-Type': 'audio/wav',
					'X-Segment-Index': '0',
					'X-Speaker-Id': speakerId,
					'X-Start-Ms': '100',
					'X-End-Ms': '1100',
					...overrides,
				},
			}),
			{ ...env, GATEWAY_API_TOKEN: 'test-token' } as WorkerEnv,
			createExecutionContext(),
		);
	return { stub, sessionId, key, send };
}

afterEach(() => vi.restoreAllMocks());

describe('audio chunk transcription API', () => {
	it('persists audio before inference, saves text, and caches identical retries', async () => {
		const { stub, key, send } = await setup();
		const run = vi.fn(async () => {
			expect(await env.RECORDINGS.head(key)).not.toBeNull();
			return { text: ' 議事録 ', transcription_info: { language: 'ja' } };
		});
		await runInDurableObject(stub, (instance) => {
			vi.spyOn(instance['env'].AI, 'run').mockImplementation(run);
		});
		const response = await send();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ model: TRANSCRIPTION_MODEL, language: 'ja', text: '議事録' });
		expect(await env.RECORDINGS.head(key)).toBeNull();
		expect((await send()).status).toBe(200);
		expect(run).toHaveBeenCalledOnce();
		expect((await send(wav(), { 'X-Speaker-Id': '32345678901234567' })).status).toBe(409);
		const changed = wav();
		new Uint8Array(changed)[44] = 1;
		expect((await send(changed)).status).toBe(409);
	});

	it('retains failed audio and retries inference without allowing replacement', async () => {
		const { stub, key, send } = await setup('processing');
		const run = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ text: '' });
		await runInDurableObject(stub, (instance) => {
			vi.spyOn(instance['env'].AI, 'run').mockImplementation(run);
		});
		expect((await send()).status).toBe(503);
		expect(await env.RECORDINGS.head(key)).not.toBeNull();
		expect((await send(wav(), { 'X-Start-Ms': '101', 'X-End-Ms': '1101' })).status).toBe(409);
		expect((await send()).status).toBe(200);
		expect(await env.RECORDINGS.head(key)).toBeNull();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('shares inference between concurrent identical retries', async () => {
		const { stub, send } = await setup();
		let release!: () => void;
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = vi.fn(async () => {
			notifyStarted();
			await blocked;
			return { text: '共有' };
		});
		await runInDurableObject(stub, (instance) => {
			vi.spyOn(instance['env'].AI, 'run').mockImplementation(run);
		});
		const first = send();
		await started;
		const second = send();
		expect((await send(wav(), { 'X-Speaker-Id': '32345678901234567' })).status).toBe(409);
		release();
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
		expect(run).toHaveBeenCalledOnce();
	});

	it('rejects unauthenticated requests and sessions from a different channel', async () => {
		const { send, stub, sessionId } = await setup();
		expect((await send(wav(), { Authorization: 'Bearer wrong-token' })).status).toBe(401);
		const other = env.VOICE_CHANNEL_SESSION.getByName(`${guildId}:42345678901234567`);
		expect(await other.transcribeSegment(sessionId, { index: 0, speakerId, startMs: 100, endMs: 1100 }, wav())).toEqual({
			ok: false,
			code: 'SESSION_NOT_FOUND',
		});
		await stub.markProcessingStarted(sessionId);
		await stub.completeSession(sessionId, { endedAt: new Date().toISOString(), durationMs: 1000, manifestSizeBytes: 1 });
		expect((await send()).status).toBe(409);
	});

	it.each(['starting', 'failed'])('rejects chunks in %s state', async (state) => {
		const { send, key } = await setup(state);
		expect((await send()).status).toBe(409);
		expect(await env.RECORDINGS.head(key)).toBeNull();
	});

	it.each<Record<string, string>>([
		{ 'X-Segment-Index': '-1' },
		{ 'X-Segment-Index': '9007199254740992' },
		{ 'X-Speaker-Id': 'bad' },
		{ 'X-Start-Ms': '1100' },
		{ 'X-End-Ms': '60101' },
		{ 'Content-Type': 'application/json' },
	])('rejects invalid metadata or content type %j', async (headers) => {
		const { send } = await setup();
		expect((await send(wav(), headers)).status).toBe(400);
	});

	it('rejects invalid WAV format, duration mismatch, and oversized bodies without trusting Content-Length', async () => {
		const { send } = await setup();
		const stereo = wav();
		new DataView(stereo).setUint16(22, 2, true);
		expect((await send(stereo)).status).toBe(400);
		expect((await send(wav(2000))).status).toBe(400);
		expect((await send(new ArrayBuffer(MAX_AUDIO_BYTES + 1), { 'Content-Length': '1' })).status).toBe(400);
	});
});
