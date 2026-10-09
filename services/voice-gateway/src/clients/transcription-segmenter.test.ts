import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TranscriptionSegmentMetadata } from './transcription-api.ts';
import { TranscriptionSegmenter } from './transcription-segmenter.ts';

const session = { guildId: '1', channelId: '2', sessionId: 'meeting' };
function audio(seconds: number, value = 0.1): Buffer {
	const pcm = Buffer.alloc(seconds * 16000 * 4);
	for (let offset = 0; offset < pcm.length; offset += 4) pcm.writeFloatLE(value, offset);
	return pcm;
}

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), 'gateway-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const calls: Array<TranscriptionSegmentMetadata & { wav: Buffer }> = [];
	const segmenter = new TranscriptionSegmenter(
		{
			transcribeWav: async (_session, wav, metadata) => {
				calls.push({ ...metadata, wav });
				return { model: 'whisper', language: 'ja', text: `text-${metadata.speakerId}` };
			},
		},
		directory,
		session,
	);
	return { directory, calls, segmenter };
}

void test('speaker buffers remain separate and completed transcript is chronological', async (t) => {
	const { calls, segmenter } = await fixture(t);
	segmenter.addAudio('20', 5000, audio(10, 0.2));
	segmenter.addAudio('10', 0, audio(10, 0.1));
	segmenter.flushSilent(16500);
	const result = await segmenter.finish();
	assert.equal(calls.length, 2);
	assert.deepEqual(
		result.segments.map(({ speakerId }) => speakerId),
		['10', '20'],
	);
	assert.equal(calls[0]!.wav.readInt16LE(44), Math.round(0.2 * 32767));
	assert.equal(calls[1]!.wav.readInt16LE(44), Math.round(0.1 * 32767));
	assert.match(result.text, /^\[00:00:00\] speaker=10: text-10\n\[00:00:05\] speaker=20:/);
	assert.equal(segmenter.getSnapshot(), result.text);
});

void test('flushes after 1.5 seconds silence only when duration is at least ten seconds', async (t) => {
	const { calls, segmenter } = await fixture(t);
	segmenter.addAudio('10', 0, audio(10));
	segmenter.flushSilent(11499);
	assert.equal(calls.length, 0);
	segmenter.flushSilent(11500);
	segmenter.addAudio('20', 0, audio(2));
	segmenter.flushSilent(30000);
	const result = await segmenter.finish();
	assert.deepEqual(
		result.segments.map(({ speakerId, endMs }) => ({ speakerId, endMs })),
		[
			{ speakerId: '10', endMs: 10000 },
			{ speakerId: '20', endMs: 2000 },
		],
	);
});

void test('combines short utterances with silent gaps and flushes exact sixty-second boundaries', async (t) => {
	const { calls, segmenter } = await fixture(t);
	segmenter.addAudio('10', 0, audio(2));
	segmenter.addAudio('10', 5000, audio(2));
	segmenter.addAudio('20', 1000, audio(61));
	const result = await segmenter.finish();
	const combined = calls.find(({ speakerId }) => speakerId === '10')!;
	assert.equal(combined.endMs, 7000);
	assert.equal(combined.wav.length, 44 + 7000 * 32);
	assert.equal(combined.wav.readInt16LE(44 + 3000 * 32), 0);
	assert.deepEqual(
		result.segments.filter(({ speakerId }) => speakerId === '20').map(({ startMs, endMs }) => [startMs, endMs]),
		[
			[1000, 61000],
			[61000, 62000],
		],
	);
});

void test('large idle gaps split short chunks without generating an oversized WAV', async (t) => {
	const { calls, segmenter } = await fixture(t);
	segmenter.addAudio('10', 0, audio(1));
	segmenter.addAudio('10', 120000, audio(1));
	await segmenter.finish();
	assert.deepEqual(
		calls.map(({ startMs, endMs }) => [startMs, endMs]),
		[
			[0, 1000],
			[120000, 121000],
		],
	);
});

void test('silent audio does not create hallucination-prone chunks', async (t) => {
	const { calls, segmenter } = await fixture(t);
	segmenter.addAudio('10', 0, audio(60, 0));
	assert.equal((await segmenter.finish()).text, '');
	assert.equal(calls.length, 0);
});

void test('failed transcription retains audio and metadata for every pending chunk and rejects finish', async (t) => {
	const { directory } = await fixture(t);
	const segmenter = new TranscriptionSegmenter(
		{
			transcribeWav: async () => {
				throw new Error('upstream unavailable');
			},
		},
		directory,
		session,
	);
	segmenter.addAudio('10', 0, audio(60));
	segmenter.addAudio('20', 0, audio(2));
	await assert.rejects(segmenter.finish(), /upstream unavailable/);
	assert.deepEqual((await readdir(directory)).sort(), [
		'pending-000000.json',
		'pending-000000.wav',
		'pending-000001.json',
		'pending-000001.wav',
	]);
	assert.equal(JSON.parse(await readFile(join(directory, 'pending-000001.json'), 'utf8')).speakerId, '20');
});

void test('overload fails explicitly and retains the triggering chunk instead of growing an unbounded queue', async (t) => {
	const { directory } = await fixture(t);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const segmenter = new TranscriptionSegmenter(
		{
			transcribeWav: async () => {
				await blocked;
				return { model: 'whisper', language: 'ja', text: 'text' };
			},
		},
		directory,
		session,
	);
	const pcm = audio(60);
	for (let index = 0; index < 40; index++) segmenter.addAudio('10', index * 60000, pcm);
	release();
	await assert.rejects(segmenter.finish(), /falling behind/);
	const files = await readdir(directory);
	assert.equal(files.filter((file) => file.endsWith('.wav')).length, 34);
	assert.equal(files.filter((file) => file.endsWith('.json')).length, 34);
});

void test('short idle utterances are sent after sixty seconds without waiting for meeting stop', async (t) => {
	const { calls, directory, segmenter } = await fixture(t);
	segmenter.addAudio('10', 5000, audio(2));
	segmenter.flushSilent(64999);
	assert.equal(calls.length, 0);
	segmenter.flushSilent(65000);
	// Wait for the asynchronous disk persistence and transcription without stopping the recorder.
	for (let attempt = 0; attempt < 100 && calls.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.startMs, 5000);
	assert.equal(calls[0]!.endMs, 7000);
	await segmenter.finish();
	assert.deepEqual(await readdir(directory), ['transcription-segments.jsonl']);
});
