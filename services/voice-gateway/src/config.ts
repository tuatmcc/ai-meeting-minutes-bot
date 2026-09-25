import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

export type VoiceGatewayConfig = {
	token: string;
	guildId: string;
	voiceChannelId: string;
	recordSeconds: number;
	recordingsDir: string;
};

function loadLocalEnv(): void {
	const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
	const envFile = candidates.find((candidate) => existsSync(candidate));
	if (envFile) {
		loadEnvFile(envFile);
	}
}

loadLocalEnv();

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function positiveNumberEnv(name: string, defaultValue: number): number {
	const rawValue = process.env[name];
	if (!rawValue) {
		return defaultValue;
	}

	const value = Number(rawValue);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return value;
}

function parseDiscordChannelId(value: string): { channelId: string; guildId?: string } {
	if (/^\d+$/.test(value)) {
		return { channelId: value };
	}

	const urlMatch = value.match(/^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)(?:\/.*)?$/);
	if (urlMatch) {
		return { guildId: urlMatch[1], channelId: urlMatch[2] };
	}

	throw new Error('DISCORD_VOICE_CHANNEL_ID must be a Discord channel ID or channel URL');
}

export function loadConfig(): VoiceGatewayConfig {
	const parsedChannel = parseDiscordChannelId(requiredEnv('DISCORD_VOICE_CHANNEL_ID'));
	return {
		token: requiredEnv('DISCORD_BOT_TOKEN'),
		guildId: process.env.DISCORD_GUILD_ID?.trim() || parsedChannel.guildId || requiredEnv('DISCORD_GUILD_ID'),
		voiceChannelId: parsedChannel.channelId,
		recordSeconds: positiveNumberEnv('RECORD_SECONDS', 30),
		recordingsDir: resolve(process.env.RECORDINGS_DIR ?? 'var/recordings'),
	};
}
