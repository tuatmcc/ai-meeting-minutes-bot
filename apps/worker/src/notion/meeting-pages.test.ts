/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerEnv } from '../env.js';
import { searchNotionDataSources } from './meeting-pages.js';

const pageId = '12345678-90ab-cdef-1234-567890abcdef';

afterEach(() => vi.unstubAllGlobals());

describe('searchNotionDataSources', () => {
	it('returns selectable titled databases from the shared Notion workspace', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.includes('/pages/')) {
				return Response.json({ properties: { Name: { type: 'title', title: [{ plain_text: 'Meetings' }] } } });
			}
			return Response.json({
				results: [
					{
						id: pageId,
						object: 'data_source',
						title: [{ plain_text: 'Weekly meeting' }],
						database_parent: { type: 'page_id', page_id: 'parent-page-id' },
					},
					{ id: 'no-title', object: 'data_source', title: [] },
				],
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(searchNotionDataSources({ NOTION_API_TOKEN: 'test-token' } as WorkerEnv, 'weekly')).resolves.toEqual([
			{ id: pageId, title: 'Weekly meeting', parentTitle: 'Meetings' },
		]);
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.notion.com/v1/search',
			expect.objectContaining({ method: 'POST', body: expect.stringContaining('weekly') }),
		);
	});
});
