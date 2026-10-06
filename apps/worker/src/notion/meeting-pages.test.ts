/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../env.js';
import { searchNotionPages } from './meeting-pages.js';

const pageId = '12345678-90ab-cdef-1234-567890abcdef';

afterEach(() => vi.unstubAllGlobals());

describe('searchNotionPages', () => {
	it('returns selectable titled pages from the shared Notion workspace', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				results: [
					{
						id: pageId,
						url: 'https://www.notion.so/meeting',
						properties: { title: { type: 'title', title: [{ plain_text: 'Weekly meeting' }] } },
					},
					{ id: 'no-title', properties: { Name: { type: 'title', title: [] } } },
				],
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(searchNotionPages({ NOTION_API_TOKEN: 'test-token' } as WorkerEnv, 'weekly')).resolves.toEqual([
			{ pageId, pageUrl: 'https://www.notion.so/meeting', title: 'Weekly meeting' },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.notion.com/v1/search',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('weekly') }),
		);
	});
});
