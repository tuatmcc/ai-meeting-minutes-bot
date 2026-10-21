import type { APIMessageTopLevelComponent, RESTPatchAPIInteractionOriginalResponseJSONBody } from 'discord-api-types/v10';

export type DiscordInteraction = {
	id: string;
	application_id: string;
	type: number;
	token?: string;
	guild_id?: string;
	channel_id?: string;
	channel?: {
		id?: string;
		type?: number;
		guild_id?: string;
	};
	message?: {
		components?: APIMessageTopLevelComponent[];
	};
	data?: {
		name?: string;
		custom_id?: string;
		values?: string[];
		options?: Array<{ name?: string; type?: number; value?: unknown; focused?: boolean }>;
	};
};

export type ComponentContext = {
	guildId: string;
	channelId: string;
};

export type ParsedCommand = {
	action: 'start' | 'stop' | 'imakita' | 'notion_retry' | 'meeting' | 'status';
	guildId: string;
	channelId: string;
	notionParentPageId: string | null;
	notionDataSourceId?: string;
	rememberNotionParentPage?: boolean;
};

export type CommandMessage = string | RESTPatchAPIInteractionOriginalResponseJSONBody;

export type CommandParseResult = { ok: true; command: ParsedCommand } | { ok: false; reason: 'unsupported' };

export type BodyReadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too-large' | 'read-failed' };
