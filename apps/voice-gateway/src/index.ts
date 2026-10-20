import { Client, Events, GatewayIntentBits } from 'discord.js';
import { loadConfig } from './config.ts';
import { GatewayControlClient } from './clients/gateway-control.ts';
import { SessionApi } from './clients/session-api.ts';
import { TranscriptionApi } from './clients/transcription-api.ts';
import { logger as baseLogger } from './logger.ts';
import { RecordingManager } from './recording-manager.ts';

const config = loadConfig();
const logger = baseLogger.child({ component: 'main' });
const sessionApi = new SessionApi(config.workerApiUrl, config.workerApiToken);
const transcriptionApi = new TranscriptionApi(config.workerApiUrl, config.workerApiToken);
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const recordingManager = new RecordingManager(client, config.recordingsDir, sessionApi, transcriptionApi);

const clientReady = new Promise<void>((resolve) => {
	client.once(Events.ClientReady, (readyClient) => {
		logger.info({ userTag: readyClient.user.tag }, 'Discord client logged in');
		resolve();
	});
});

client.on(Events.Error, (error) => {
	logger.error({ err: error }, 'Discord client error');
});

await client.login(config.token);
await clientReady;

const gatewayControl = new GatewayControlClient(config.workerControlUrl, config.workerControlToken, (command) =>
	recordingManager.handleGatewayCommand(command),
);
const gatewayControlTask = gatewayControl.run();
let shuttingDown = false;

async function shutdown(): Promise<void> {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	recordingManager.beginShutdown();
	logger.info({ activeRecordingCount: recordingManager.activeRecordingCount }, 'Shutting down voice gateway');
	try {
		await gatewayControl.drain();
		await recordingManager.stopAll();
	} finally {
		await gatewayControl.stop();
		await gatewayControlTask;
		await client.destroy();
		logger.info('Voice gateway shutdown complete');
	}
}

process.once('SIGINT', () => {
	void shutdown().catch((error: unknown) => {
		logger.error({ err: error }, 'Shutdown failed');
		process.exitCode = 1;
	});
});
process.once('SIGTERM', () => {
	void shutdown().catch((error: unknown) => {
		logger.error({ err: error }, 'Shutdown failed');
		process.exitCode = 1;
	});
});

await gatewayControlTask;
