/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const page = {
	pageId: '12345678-90ab-cdef-1234-567890abcdef',
	pageUrl: 'https://www.notion.so/weekly-meeting',
	title: 'Weekly meeting',
};

describe('voice channel Notion default', () => {
	it('stores, reads, and clears a per-channel default page', async () => {
		const channelId = crypto.randomUUID();
		const stub = env.VOICE_CHANNEL_SESSION.getByName(`notion-default:${channelId}`);

		expect(await stub.getNotionDefault()).toBeNull();
		await stub.setNotionDefault(page);
		expect(await stub.getNotionDefault()).toEqual(page);
		await stub.setNotionDefault(null);
		expect(await stub.getNotionDefault()).toBeNull();
	});
});
