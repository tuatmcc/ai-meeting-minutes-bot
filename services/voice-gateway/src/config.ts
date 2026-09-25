import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

export type VoiceGatewayConfig = {
	token: string;
	workerApiUrl: string;
	workerApiToken: string;
	workerControlToken: string;
	workerControlUrl: string;
	asrApiUrl: string;
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

function workerApiUrlEnv(): string {
	const value = requiredEnv('WORKER_API_URL');
	const url = new URL(value);
	const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
		throw new Error('WORKER_API_URL must use HTTPS, except for a local development URL');
	}
	return url.toString();
}

function asrApiUrlEnv(): string {
	const value = requiredEnv('ASR_API_URL');
	const url = new URL(value);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('ASR_API_URL must use HTTP or HTTPS');
	}
	return url.toString();
}

function workerControlUrl(workerApiUrl: string): string {
	const url = new URL('/api/v1/gateway-control/connect', workerApiUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}

export function loadConfig(): VoiceGatewayConfig {
	const workerApiUrl = workerApiUrlEnv();
	return {
		token: requiredEnv('DISCORD_BOT_TOKEN'),
		workerApiUrl,
		workerApiToken: requiredEnv('WORKER_API_TOKEN'),
		workerControlToken: requiredEnv('WORKER_CONTROL_TOKEN'),
		workerControlUrl: workerControlUrl(workerApiUrl),
		asrApiUrl: asrApiUrlEnv(),
		recordingsDir: resolve(process.env.RECORDINGS_DIR ?? 'var/recordings'),
	};
}
