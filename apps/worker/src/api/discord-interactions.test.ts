import { describe, expect, it } from 'vitest';
import { normalizeNotionPageId } from './discord-interactions.js';

const PAGE_ID = '12345678-90ab-cdef-1234-567890abcdef';

describe('normalizeNotionPageId', () => {
	it('normalizes a configured default page ID', () => {
		expect(normalizeNotionPageId(PAGE_ID.replaceAll('-', '').toUpperCase())).toBe(PAGE_ID);
	});

	it('rejects invalid configured IDs', () => {
		expect(normalizeNotionPageId('not-a-page-id')).toBeNull();
	});
});
