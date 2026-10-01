import { describe, expect, it } from 'vitest';
import { parseNotionPageId } from './discord-interactions.js';

const PAGE_ID = '12345678-90ab-cdef-1234-567890abcdef';
const DATABASE_ID = 'fedcba0987654321fedcba0987654321';

describe('parseNotionPageId', () => {
	it.each([
		`https://app.notion.com/p/workspace/${DATABASE_ID}?v=abcdefabcdefabcdefabcdefabcdefab&p=${PAGE_ID.replaceAll('-', '')}&pm=s`,
		`https://www.notion.so/${DATABASE_ID}?p=${PAGE_ID}`,
	])('uses the opened page instead of the database in %s', (url) => {
		expect(parseNotionPageId(url)).toBe(PAGE_ID);
	});

	it.each([
		`https://app.notion.com/p/meeting-${PAGE_ID.replaceAll('-', '')}`,
		`https://www.notion.so/${PAGE_ID}?v=${DATABASE_ID}`,
		`https://tuatmcc.notion.site/meeting-${PAGE_ID.toUpperCase()}`,
	])('preserves direct page URL support for %s', (url) => {
		expect(parseNotionPageId(url)).toBe(PAGE_ID);
	});

	it.each([
		`https://app.notion.com/p/${DATABASE_ID}?p=invalid`,
		`https://app.notion.com/p/${DATABASE_ID}?p=`,
		`https://app.notion.com/p/${DATABASE_ID}?p=meeting-${PAGE_ID}`,
		`https://example.com/${DATABASE_ID}?p=${PAGE_ID}`,
		`http://app.notion.com/p/${DATABASE_ID}?p=${PAGE_ID}`,
		'not a URL',
	])('rejects invalid page selections and URLs: %s', (url) => {
		expect(parseNotionPageId(url)).toBeNull();
	});
});
