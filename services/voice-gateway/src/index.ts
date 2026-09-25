import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, Events, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { loadConfig } from './config.js';
import { AsrApi } from './clients/asr-api.js';
import { uploadToR2 } from './clients/r2-upload.js';
import { SessionApi } from './clients/session-api.js';
import { VoiceRecorder } from './discord/voice-recorder.js';

const config = loadConfig();
const sessionApi = new SessionApi(config.workerApiUrl, config.workerApiToken);
const asrApi = new AsrApi(config.asrApiUrl);
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let stopping = false;
let stopRecording: (() => Promise<void>) | undefined;

async function startRecording(readyClient: Client<true>): Promise<void> {
	const guild = await readyClient.guilds.fetch(config.guildId);
	const channel = await guild.channels.fetch(config.voiceChannelId);
	if (!channel?.isVoiceBased()) {
		throw new Error(`Channel ${config.voiceChannelId} is not a voice channel`);
	}

	const botMember = await guild.members.fetch(readyClient.user.id);
	const permissions = channel.permissionsFor(botMember);
	const missingPermissions = [
		{ name: 'ViewChannel', permission: PermissionsBitField.Flags.ViewChannel },
		{ name: 'Connect', permission: PermissionsBitField.Flags.Connect },
	].filter(({ permission }) => !permissions?.has(permission));
	if (missingPermissions.length > 0) {
		throw new Error(`Missing permissions in ${channel.name}: ${missingPermissions.map(({ name }) => name).join(', ')}`);
	}
	if (!permissions.has(PermissionsBitField.Flags.Speak)) {
		console.warn(`[voice] Speak permission is missing in ${channel.name}; receiving may still work`);
	}

	const connection = joinVoiceChannel({
		channelId: channel.id,
		guildId: guild.id,
		adapterCreator: guild.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: true,
	});
	connection.on('stateChange', (oldState, newState) => {
		console.log(`[voice] ${oldState.status} -> ${newState.status}`);
	});

	let sessionId: string | undefined;
	let recorder: VoiceRecorder | undefined;
	try {
		await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
		console.log(`[voice] connected to ${guild.name} / ${channel.name}`);

		const session = await sessionApi.startSession(guild.id, channel.id, randomUUID());
		sessionId = session.sessionId;
		recorder = await VoiceRecorder.create(connection.receiver, config.recordingsDir, sessionId);
		recorder.start();
		await sessionApi.markRecordingStarted(guild.id, channel.id, sessionId);
		console.log(`[recording] started: ${sessionId}`);

		stopRecording = async () => {
			if (stopping || !recorder || !sessionId) {
				return;
			}
			stopping = true;

			try {
				const result = await recorder.stop();
				await sessionApi.markProcessingStarted(guild.id, channel.id, sessionId);
				const transcription = await asrApi.transcribe(result.filePath);
				const manifestPath = join(dirname(result.filePath), 'manifest.json');
				const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
				await writeFile(manifestPath, `${JSON.stringify({ ...manifest, transcription }, null, 2)}\n`, 'utf8');

				const uploads = await sessionApi.createUploadTargets(guild.id, channel.id, sessionId);
				const manifestUpload = uploads.find(({ key }) => key.endsWith('/manifest.json'));
				if (!manifestUpload) {
					throw new Error('Worker did not return an R2 manifest upload target');
				}

				const manifestSizeBytes = await uploadToR2(manifestUpload, join(dirname(result.filePath), 'manifest.json'));
				await sessionApi.completeSession(guild.id, channel.id, sessionId, {
					endedAt: result.endedAt,
					durationMs: result.durationMs,
					manifestSizeBytes,
				});
				console.log(`[transcription] saved to R2: ${sessionId} (${transcription.model})`);
				await rm(dirname(result.filePath), { recursive: true, force: true }).catch((error: unknown) => {
					console.warn('[recording] could not remove local temporary files', error);
				});
			} catch (error) {
				console.error(`[recording] finalization failed: ${sessionId}`, error);
				await sessionApi.failSession(guild.id, channel.id, sessionId, 'recording_finalize_failed').catch((failure: unknown) => {
					console.error(`[session] failed to record finalization error: ${sessionId}`, failure);
				});
				process.exitCode = 1;
			} finally {
				connection.destroy();
				await client.destroy();
			}
		};

		setTimeout(() => {
			void stopRecording?.();
		}, config.recordSeconds * 1000).unref();
	} catch (error) {
		if (recorder) {
			await recorder.stop().catch((stopError: unknown) => {
				console.error('[recording] cleanup after startup failure failed', stopError);
			});
		}
		if (sessionId) {
			await sessionApi.failSession(guild.id, channel.id, sessionId, 'recording_start_failed').catch((failure: unknown) => {
				console.error(`[session] failed to record startup error: ${sessionId}`, failure);
			});
		}
		connection.destroy();
		throw error;
	}
}

client.once(Events.ClientReady, (readyClient) => {
	void startRecording(readyClient).catch(async (error: unknown) => {
		console.error('[voice] startup failed', error);
		await client.destroy();
		process.exitCode = 1;
	});
});

client.on(Events.Error, (error) => {
	console.error('[discord] client error', error);
});

async function shutdown(): Promise<void> {
	if (stopRecording) {
		await stopRecording();
		return;
	}
	await client.destroy();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await client.login(config.token);
