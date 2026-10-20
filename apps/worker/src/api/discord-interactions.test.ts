/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { WorkerEnv } from '../env.js';
import { handleDiscordInteraction } from './discord-interactions.js';

const guildId = '12345678901234567';
const speakerId = '22345678901234567';
const applicationId = '1552896143392907294';
let privateKey: CryptoKey;
let publicKeyHex: string;

beforeAll(async () => {
	const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
	if (!('privateKey' in generated) || !('publicKey' in generated)) throw new Error('Ed25519 key pair generation failed');
	const keyPair = generated as CryptoKeyPair;
	privateKey = keyPair.privateKey;
	const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
	if (!(rawPublicKey instanceof ArrayBuffer)) throw new Error('Ed25519 public key export failed');
	publicKeyHex = toHex(new Uint8Array(rawPublicKey));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('meeting_imakita interaction', () => {
	it('summarizes finalized transcript in Worker and edits the interaction response without queuing a Gateway command', async () => {
		const { channelId } = await createSession('recording', '議題を決めた。田中さんが資料を作る。');
		const run = vi.spyOn(env.AI, 'run').mockImplementation(async (_model, input) => {
			return lastMessageContent(input)?.includes('人名として明示')
				? { response: '{"people":[]}' }
				: { response: '- 議題を決定し、田中さんが資料を作る。' };
		});
		run.mockClear();
		const { request, edits, gatewayGetByName, runCommand } = await interactionRequest(channelId);

		const response = await handleDiscordInteraction(request, workerEnv(), executionContext());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
		await flushInteractionTasks();

		expect(edits.map(({ content }) => content)).toEqual([
			'今北産業を作成しています。文字起こしの確定を待つ場合があります。',
			'**今北産業**\n- 議題を決定し、田中さんが資料を作る。',
		]);
		expect(run.mock.calls[0]?.[0]).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
		expect(lastMessageContent(run.mock.calls[0]?.[1])).toContain(`[00:00:00] speaker=${speakerId}: 議題を決めた。田中さんが資料を作る。`);
		expect(gatewayGetByName).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('replies that there is no finalized transcription without calling Workers AI', async () => {
		const { channelId } = await createSession('recording', '');
		const run = vi.spyOn(env.AI, 'run');
		run.mockClear();
		const { request, edits, gatewayGetByName } = await interactionRequest(channelId);

		await handleDiscordInteraction(request, workerEnv(), executionContext());
		await flushInteractionTasks();

		expect(edits.at(-1)?.content).toBe('確定した文字起こしがありません。文字起こしの確定後にもう一度お試しください。');
		expect(run).not.toHaveBeenCalled();
		expect(gatewayGetByName).not.toHaveBeenCalled();
	});

	it('does not summarize when the session is not recording', async () => {
		const { channelId } = await createSession('processing', '確定済みの発言');
		const run = vi.spyOn(env.AI, 'run');
		run.mockClear();
		const { request, edits, gatewayGetByName } = await interactionRequest(channelId);

		await handleDiscordInteraction(request, workerEnv(), executionContext());
		await flushInteractionTasks();

		expect(edits.at(-1)?.content).toBe('録音を終了し、文字起こしを処理中です。');
		expect(run).not.toHaveBeenCalled();
		expect(gatewayGetByName).not.toHaveBeenCalled();
	});
});

async function createSession(state: 'recording' | 'processing', text: string | null): Promise<{ channelId: string }> {
	const channelId = String(BigInt(guildId) + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]));
	const stub = env.VOICE_CHANNEL_SESSION.getByName(`${guildId}:${channelId}`);
	const started = await stub.startSession(guildId, channelId, crypto.randomUUID());
	if (!started.ok) throw new Error('Session setup failed');
	const sessionId = started.session.sessionId;
	await stub.markRecordingStarted(sessionId);
	if (text !== null) {
		await runInDurableObject(stub, (instance) => {
			vi.spyOn(instance['env'].AI, 'run').mockResolvedValue({ text, transcription_info: { language: 'ja' } });
		});
		const operation = await stub.transcribeSegment(sessionId, { index: 0, speakerId, startMs: 0, endMs: 1000 }, wav());
		if (!operation.ok) throw new Error('Transcript setup failed');
	}
	if (state === 'processing') await stub.markProcessingStarted(sessionId);
	return { channelId };
}

function workerEnv(): WorkerEnv {
	return {
		...env,
		DISCORD_APPLICATION_ID: applicationId,
		DISCORD_APPLICATION_PUBLIC_KEY: publicKeyHex,
		VOICE_CHANNEL_SESSION: {
			getByName: (name: string) => env.VOICE_CHANNEL_SESSION.getByName(name),
		},
		GATEWAY_CONTROL: { getByName: gatewayGetByName },
	} as unknown as WorkerEnv;
}

let gatewayGetByName: ReturnType<typeof vi.fn>;

async function interactionRequest(channelId: string) {
	const edits: Array<{ url: string; content: string }> = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (typeof init?.body !== 'string') throw new Error('Expected a JSON interaction response');
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		edits.push({ url, content: String(JSON.parse(init.body).content) });
		return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
	});
	vi.stubGlobal('fetch', fetchMock);
	const runCommand = vi.fn();
	gatewayGetByName = vi.fn(() => ({ enqueueCommand: runCommand }));
	const interaction = {
		id: '33345678901234567',
		application_id: applicationId,
		type: 2,
		token: 'interaction-token',
		guild_id: guildId,
		channel_id: channelId,
		channel: { id: channelId, type: 2, guild_id: guildId },
		data: { name: 'meeting_imakita' },
	};
	const body = new TextEncoder().encode(JSON.stringify(interaction));
	const timestamp = String(Math.floor(Date.now() / 1000));
	const timestampBytes = new TextEncoder().encode(timestamp);
	const signedMessage = new Uint8Array(timestampBytes.length + body.length);
	signedMessage.set(timestampBytes);
	signedMessage.set(body, timestampBytes.length);
	const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, signedMessage));
	const request = new Request('https://example.com/interactions', {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/json',
			'X-Signature-Timestamp': timestamp,
			'X-Signature-Ed25519': toHex(signature),
		},
	});
	return { request, edits, gatewayGetByName, runCommand };
}

const pendingTasks: Promise<unknown>[] = [];

function executionContext(): ExecutionContext {
	pendingTasks.length = 0;
	return { waitUntil: (promise: Promise<unknown>) => pendingTasks.push(promise) } as unknown as ExecutionContext;
}

async function flushInteractionTasks(): Promise<void> {
	await Promise.all(pendingTasks);
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function lastMessageContent(input: unknown): string | undefined {
	if (!isRecord(input) || !Array.isArray(input.messages)) return undefined;
	const message = input.messages.at(-1);
	return isRecord(message) && typeof message.content === 'string' ? message.content : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function wav(): ArrayBuffer {
	const buffer = new ArrayBuffer(44 + 32_000);
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
