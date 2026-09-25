import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, Events, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { loadConfig } from './config.ts';
import { AsrApi } from './clients/asr-api.ts';
import { GatewayControlClient, type GatewayCommand } from './clients/gateway-control.ts';
import { uploadToR2 } from './clients/r2-upload.ts';
import { SessionApi } from './clients/session-api.ts';
import type { AsrStream } from './clients/asr-stream.ts';
import { VoiceRecorder } from './discord/voice-recorder.ts';

type ActiveRecording = {
	command: GatewayCommand;
	connection: VoiceConnection;
	recorder: VoiceRecorder;
	asrStream: AsrStream;
	stopPromise?: Promise<void>;
	failureToRecord?: string;
};

const config = loadConfig();
const sessionApi = new SessionApi(config.workerApiUrl, config.workerApiToken);
const asrApi = new AsrApi(config.asrApiUrl);
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const activeRecordings = new Map<string, ActiveRecording>();
let gatewayControl: GatewayControlClient | undefined;
let gatewayControlTask: Promise<void> | undefined;
let shuttingDown = false;

const clientReady = new Promise<void>((resolve) => {
	client.once(Events.ClientReady, (readyClient) => {
		console.log(`[discord] logged in as ${readyClient.user.tag}`);
		resolve();
	});
});

async function startRecording(command: GatewayCommand): Promise<void> {
	const session = await sessionApi.getActiveSession(command.guildId, command.channelId);
	if (!session || session.sessionId !== command.sessionId || (session.state !== 'starting' && session.state !== 'recording')) {
		console.log(`[recording] stale start ignored: ${command.sessionId}`);
		return;
	}

	const existingSession = activeRecordings.get(command.sessionId);
	if (existingSession) {
		if (sameSession(existingSession.command, command)) {
			console.log(`[recording] duplicate start ignored: ${command.sessionId}`);
			return;
		}
		throw new Error('Session ID is already active for a different voice channel');
	}
	if ([...activeRecordings.values()].some(({ command: active }) => active.guildId === command.guildId)) {
		throw new Error(`Gateway is already recording in guild ${command.guildId}`);
	}

	let connection: VoiceConnection | undefined;
	let recorder: VoiceRecorder | undefined;
	let asrStream: AsrStream | undefined;
	try {
		const guild = await client.guilds.fetch(command.guildId);
		const channel = await guild.channels.fetch(command.channelId);
		if (!channel?.isVoiceBased()) {
			throw new Error(`Channel ${command.channelId} is not a voice channel`);
		}

		const botMember = await guild.members.fetch(client.user!.id);
		const permissions = channel.permissionsFor(botMember);
		const missingPermissions = [
			{ name: 'ViewChannel', permission: PermissionsBitField.Flags.ViewChannel },
			{ name: 'Connect', permission: PermissionsBitField.Flags.Connect },
		].filter(({ permission }) => !permissions?.has(permission));
		if (missingPermissions.length > 0) {
			throw new Error(`Missing permissions in ${channel.name}: ${missingPermissions.map(({ name }) => name).join(', ')}`);
		}

		connection = joinVoiceChannel({
			channelId: channel.id,
			guildId: guild.id,
			adapterCreator: guild.voiceAdapterCreator,
			selfDeaf: false,
			selfMute: true,
		});
		connection.on('stateChange', (oldState, newState) => {
			console.log(`[voice] ${oldState.status} -> ${newState.status} (${guild.id})`);
		});
		connection.on('error', (error) => {
			console.error(`[voice] connection error (${guild.id})`, error);
		});

		await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
		console.log(`[voice] connected to ${guild.name} / ${channel.name}`);

		asrStream = await asrApi.openStream((partial) => {
			console.log(`[transcription] partial updated: ${command.sessionId} (${partial.text.length} characters)`);
		});
		recorder = await VoiceRecorder.create(connection.receiver, config.recordingsDir, command.sessionId, (pcm) => asrStream?.sendAudio(pcm));
		recorder.start();
		await sessionApi.markRecordingStarted(command.guildId, command.channelId, command.sessionId);

		activeRecordings.set(command.sessionId, { command, connection, recorder, asrStream });
		console.log(`[recording] started: ${command.sessionId}`);
	} catch (error) {
		asrStream?.abort();
		if (recorder) {
			await recorder.stop().catch((stopError: unknown) => {
				console.error('[recording] cleanup after startup failure failed', stopError);
			});
		}
		connection?.destroy();
		throw error;
	}
}

async function stopRecording(recording: ActiveRecording): Promise<void> {
	if (recording.stopPromise) {
		await recording.stopPromise;
		return;
	}
	if (recording.failureToRecord) {
		await sessionApi.failSession(
			recording.command.guildId,
			recording.command.channelId,
			recording.command.sessionId,
			recording.failureToRecord,
		);
		activeRecordings.delete(recording.command.sessionId);
		return;
	}

	const stopPromise = (async () => {
		const { command, recorder, asrStream, connection } = recording;
		let failSessionRecorded = false;
		try {
			const result = await recorder.stop();
			await sessionApi.markProcessingStarted(command.guildId, command.channelId, command.sessionId);
			const transcription = await asrStream.finish();
			const manifestPath = join(result.sessionDir, 'manifest.json');
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
			await writeFile(manifestPath, `${JSON.stringify({ ...manifest, transcription }, null, 2)}\n`, 'utf8');

			const uploads = await sessionApi.createUploadTargets(command.guildId, command.channelId, command.sessionId);
			const manifestUpload = uploads.find(({ key }) => key.endsWith('/manifest.json'));
			if (!manifestUpload) {
				throw new Error('Worker did not return an R2 manifest upload target');
			}

			const manifestSizeBytes = await uploadToR2(manifestUpload, manifestPath);
			await sessionApi.completeSession(command.guildId, command.channelId, command.sessionId, {
				endedAt: result.endedAt,
				durationMs: result.durationMs,
				manifestSizeBytes,
			});
			console.log(`[transcription] saved to R2: ${command.sessionId} (${transcription.model})`);
			await rm(result.sessionDir, { recursive: true, force: true }).catch((error: unknown) => {
				console.warn('[recording] could not remove local temporary files', error);
			});
		} catch (error) {
			console.error(`[recording] finalization failed: ${command.sessionId}`, error);
			try {
				await sessionApi.failSession(command.guildId, command.channelId, command.sessionId, 'recording_finalize_failed');
				failSessionRecorded = true;
			} catch (failure) {
				recording.failureToRecord = 'recording_finalize_failed';
				throw failure;
			}
		} finally {
			asrStream.abort();
			connection.destroy();
			if (failSessionRecorded || !recording.failureToRecord) {
				activeRecordings.delete(command.sessionId);
			}
		}
	})();
	recording.stopPromise = stopPromise;

	try {
		await stopPromise;
	} catch (error) {
		if (recording.stopPromise === stopPromise) {
			recording.stopPromise = undefined;
		}
		throw error;
	}
}

async function handleGatewayCommand(command: GatewayCommand): Promise<void> {
	if (command.action === 'start') {
		try {
			await startRecording(command);
		} catch (error) {
			console.error(`[recording] startup failed: ${command.sessionId}`, error);
			await sessionApi.failSession(command.guildId, command.channelId, command.sessionId, 'recording_start_failed');
		}
		return;
	}

	const recording = activeRecordings.get(command.sessionId);
	if (!recording || !sameSession(recording.command, command)) {
		console.log(`[recording] duplicate or stale stop ignored: ${command.sessionId}`);
		const session = await sessionApi.getActiveSession(command.guildId, command.channelId);
		if (session?.sessionId === command.sessionId && (session.state === 'starting' || session.state === 'recording')) {
			await sessionApi.failSession(command.guildId, command.channelId, command.sessionId, 'gateway_recording_missing');
		}
		return;
	}
	await stopRecording(recording);
}

function sameSession(left: GatewayCommand, right: GatewayCommand): boolean {
	return left.sessionId === right.sessionId && left.guildId === right.guildId && left.channelId === right.channelId;
}

client.on(Events.Error, (error) => {
	console.error('[discord] client error', error);
});

await client.login(config.token);
await clientReady;

gatewayControl = new GatewayControlClient(config.workerControlUrl, config.workerControlToken, handleGatewayCommand);
gatewayControlTask = gatewayControl.run();

async function shutdown(): Promise<void> {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	try {
		await gatewayControl?.stop();
		await gatewayControlTask;
		await Promise.all([...activeRecordings.values()].map((recording) => stopRecording(recording)));
	} finally {
		await client.destroy();
	}
}

process.once('SIGINT', () => {
	void shutdown().catch((error: unknown) => {
		console.error('[shutdown] failed', error);
		process.exitCode = 1;
	});
});
process.once('SIGTERM', () => {
	void shutdown().catch((error: unknown) => {
		console.error('[shutdown] failed', error);
		process.exitCode = 1;
	});
});

await gatewayControlTask;
