import { resolve } from 'node:path';

export type VoiceGatewayConfig = {
	token: string;
	guildId: string;
	voiceChannelId: string;
	recordSeconds: number;
	recordingsDir: string;
};

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

export function loadConfig(): VoiceGatewayConfig {
	return {
		token: requiredEnv('DISCORD_BOT_TOKEN'),
		guildId: requiredEnv('DISCORD_GUILD_ID'),
		voiceChannelId: requiredEnv('DISCORD_VOICE_CHANNEL_ID'),
		recordSeconds: positiveNumberEnv('RECORD_SECONDS', 30),
		recordingsDir: resolve(process.env.RECORDINGS_DIR ?? 'var/recordings'),
	};
}
