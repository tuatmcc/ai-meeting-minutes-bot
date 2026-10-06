/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const database = {
	dataSourceId: '12345678-90ab-cdef-1234-567890abcdef',
	title: 'Weekly meeting',
	titleProperty: 'Name',
};

describe('voice channel Notion database', () => {
	it('stores and reads the linked per-channel database', async () => {
		const channelId = crypto.randomUUID();
		const stub = env.VOICE_CHANNEL_SESSION.getByName(`notion-database:${channelId}`);

		expect(await stub.getNotionDatabase()).toBeNull();
		await stub.setNotionDatabase(database);
		expect(await stub.getNotionDatabase()).toEqual(database);
	});
});
