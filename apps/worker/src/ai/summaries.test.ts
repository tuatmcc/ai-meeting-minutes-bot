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
	it.each([
		{ name: 'Notion', summarize: summarizeMeetingMinutes, model: '@cf/google/gemma-4-26b-a4b-it' },
		{ name: 'imakita', summarize: summarizeForCatchUp, model: '@cf/qwen/qwen3-30b-a3b-fp8' },
	])('uses the correct model without thinking for $name', async ({ name, summarize, model }) => {
		run.mockImplementation(
			async (
				_model: string,
				input: { messages: { role: string; content: string }[]; chat_template_kwargs?: { enable_thinking?: boolean } },
			) => {
				const noThinking =
					input.chat_template_kwargs?.enable_thinking === false || input.messages.some((message) => message.content.endsWith('/no_think'));
				return {
					choices: [
						{
							message: {
								role: 'assistant',
								content: noThinking ? '- 展示会のデモを金曜日までに準備する。' : '',
								reasoning_content: '思考',
							},
						},
					],
				};
			},
		);

		await expect(summarize(workerEnv, transcript)).resolves.toBe('- 展示会のデモを金曜日までに準備する。');
		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith(
			model,
			expect.objectContaining(
				name === 'Notion' ? { max_completion_tokens: 2_048, chat_template_kwargs: { enable_thinking: false } } : { max_tokens: 350 },
			),
		);
		expect(run.mock.calls[0][1].messages.at(-1).content.endsWith('/no_think')).toBe(name === 'imakita');
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

	it.each([
		{ name: 'Notion', summarize: summarizeMeetingMinutes, model: '@cf/google/gemma-4-26b-a4b-it' },
		{ name: 'imakita', summarize: summarizeForCatchUp, model: '@cf/qwen/qwen3-30b-a3b-fp8' },
	])('uses the correct model for every chunk and the final $name summary', async ({ name, summarize, model }) => {
		run.mockResolvedValue({ response: '- デモを準備する。' });

		await summarize(workerEnv, 'あ'.repeat(8_001));

		expect(run).toHaveBeenCalledTimes(3);
		for (const [calledModel, input] of run.mock.calls) {
			expect(calledModel).toBe(model);
			expect(input.messages.at(-1)?.content.endsWith('/no_think')).toBe(name === 'imakita');
			if (name === 'Notion') {
				expect(input.chat_template_kwargs).toEqual({ enable_thinking: false });
			}
		}
		if (name === 'Notion') {
			expect(run.mock.calls.map(([, input]) => input.max_completion_tokens)).toEqual([350, 350, 2_048]);
		}
	});
});
