/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { WorkerEnv } from '../env.js';
import { summarizeForCatchUp, summarizeMeetingMinutes } from './summaries.js';

const run = vi.fn();
const workerEnv = env as WorkerEnv;
const transcript = '来週の展示会ではデモを公開する。田中さんが金曜日までに準備する。';

beforeEach(() => {
	vi.spyOn(env.AI, 'run').mockImplementation(run);
});

afterEach(() => {
	vi.restoreAllMocks();
	run.mockReset();
});

describe('Workers AI summaries', () => {
	it.each([summarizeMeetingMinutes, summarizeForCatchUp])('disables thinking to reserve tokens for the summary', async (summarize) => {
		run.mockImplementation(async (_model: string, input: { messages: { role: string; content: string }[] }) => {
			const noThinking = input.messages.some((message) => message.content.endsWith('/no_think'));
			return {
				choices: [
					{
						message: { role: 'assistant', content: noThinking ? '- 展示会のデモを金曜日までに準備する。' : '', reasoning_content: '思考' },
					},
				],
			};
		});

		await expect(summarize(workerEnv, transcript)).resolves.toBe('- 展示会のデモを金曜日までに準備する。');
		expect(run).toHaveBeenCalledOnce();
	});

	it.each([
		' <think>\n\n</think>\n- デモを準備する。 ',
		{ response: '<think>内容を整理する。</think>\n- デモを準備する。' },
		{ choices: [{ message: { role: 'assistant', content: '<think></think>\n- デモを準備する。', reasoning_content: '思考' } }] },
	])('returns only the answer from %j', async (output) => {
		run.mockResolvedValue(output);

		await expect(summarizeMeetingMinutes(workerEnv, transcript)).resolves.toBe('- デモを準備する。');
	});

	it.each([
		{ choices: [{ message: { role: 'assistant', content: '', reasoning_content: '思考' } }] },
		{ response: '<think>途中で出力上限に達した' },
		{ response: '<think>思考だけ</think>' },
	])('rejects reasoning-only output %j', async (output) => {
		run.mockResolvedValue(output);

		await expect(summarizeMeetingMinutes(workerEnv, transcript)).rejects.toThrow('Workers AI returned an empty summary');
	});

	it('disables thinking for every chunk and the final summary', async () => {
		run.mockResolvedValue({ response: '- デモを準備する。' });

		await summarizeMeetingMinutes(workerEnv, 'あ'.repeat(8_001));

		expect(run).toHaveBeenCalledTimes(3);
		for (const [, input] of run.mock.calls) {
			expect(input.messages.at(-1)?.content.endsWith('/no_think')).toBe(true);
		}
	});
});
