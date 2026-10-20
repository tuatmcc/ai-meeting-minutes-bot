import { join } from 'node:path';
import { Client, PermissionsBitField } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { TranscriptionApi } from './clients/transcription-api.ts';
import type { GatewayCommand } from './clients/gateway-control.ts';
import { SessionApi, type SessionResumeInfo } from './clients/session-api.ts';
import { TranscriptionSegmenter } from './clients/transcription-segmenter.ts';
import { VoiceRecorder } from './discord/voice-recorder.ts';
import { logger as baseLogger } from './logger.ts';
import { finalizeRecording } from './recording-finalizer.ts';
import type { VoiceGatewayConfig } from './config.ts';

type StartCommand = Extract<GatewayCommand, { action: 'start' }>;

type ActiveRecording = {
	command: StartCommand;
	connection: VoiceConnection;
	recorder: VoiceRecorder;
	transcriptionSegmenter: TranscriptionSegmenter;
	resumeInfo?: SessionResumeInfo;
	stopPromise?: Promise<void>;
	failureToRecord?: string;
};

const logger = baseLogger.child({ component: 'recording-manager' });

export class RecordingManager {
	private readonly activeRecordings = new Map<string, ActiveRecording>();
	private acceptingStarts = true;

	constructor(
		private readonly client: Client,
		private readonly recordingsDir: VoiceGatewayConfig['recordingsDir'],
		private readonly sessionApi: SessionApi,
		private readonly transcriptionApi: TranscriptionApi,
	) {}

	get activeRecordingCount(): number {
		return this.activeRecordings.size;
	}

	beginShutdown(): void {
		this.acceptingStarts = false;
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.activeRecordings.values()].map((recording) => this.stopRecording(recording)));
	}

	async handleGatewayCommand(command: GatewayCommand): Promise<void> {
		if (!this.acceptingStarts && command.action === 'start') {
			logger.info({ sessionId: command.sessionId }, 'Ignored recording start during shutdown');
			return;
		}

		if (command.action === 'start') {
			try {
				await this.startRecording(command);
			} catch (error) {
				logger.error({ err: error, sessionId: command.sessionId }, 'Recording startup failed');
				await this.sessionApi.failSession(command.guildId, command.channelId, command.sessionId, 'recording_start_failed');
			}
			return;
		}

		const recording = this.activeRecordings.get(command.sessionId);
		if (!recording || !sameSession(recording.command, command)) {
			logger.info({ sessionId: command.sessionId }, 'Ignored duplicate or stale recording stop');
			const session = await this.sessionApi.getActiveSession(command.guildId, command.channelId);
			if (session?.sessionId === command.sessionId && (session.state === 'starting' || session.state === 'recording')) {
				await this.sessionApi.failSession(command.guildId, command.channelId, command.sessionId, 'gateway_recording_missing');
			}
			return;
		}
		await this.stopRecording(recording);
	}

	private async startRecording(command: StartCommand): Promise<void> {
		const session = await this.sessionApi.getActiveSession(command.guildId, command.channelId);
		if (!session || session.sessionId !== command.sessionId || (session.state !== 'starting' && session.state !== 'recording')) {
			logger.info(
				{ sessionId: command.sessionId, guildId: command.guildId, channelId: command.channelId },
				'Ignored stale recording start',
			);
			return;
		}

		const existingSession = this.activeRecordings.get(command.sessionId);
		if (existingSession) {
			if (sameSession(existingSession.command, command)) {
				logger.info({ sessionId: command.sessionId }, 'Ignored duplicate recording start');
				return;
			}
			throw new Error('Session ID is already active for a different voice channel');
		}
		if ([...this.activeRecordings.values()].some(({ command: active }) => active.guildId === command.guildId)) {
			throw new Error(`Gateway is already recording in guild ${command.guildId}`);
		}
		const resumeInfo = command.resume
			? await this.sessionApi.getResumeInfo(command.guildId, command.channelId, command.sessionId)
			: undefined;

		let connection: VoiceConnection | undefined;
		let recorder: VoiceRecorder | undefined;
		let transcriptionSegmenter: TranscriptionSegmenter | undefined;
		try {
			const guild = await this.client.guilds.fetch(command.guildId);
			const channel = await guild.channels.fetch(command.channelId);
			if (!channel?.isVoiceBased()) {
				throw new Error(`Channel ${command.channelId} is not a voice channel`);
			}

			const botMember = await guild.members.fetch(this.client.user!.id);
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
				logger.info({ guildId: guild.id, oldState: oldState.status, newState: newState.status }, 'Voice connection state changed');
			});
			connection.on('error', (error) => {
				logger.error({ err: error, guildId: guild.id }, 'Voice connection error');
			});

			await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
			logger.info(
				{ guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name },
				'Connected to voice channel',
			);

			recorder = await VoiceRecorder.create(
				connection.receiver,
				this.recordingsDir,
				command.sessionId,
				(speakerId, startMs, pcm) => transcriptionSegmenter?.addAudio(speakerId, startMs, pcm),
				(elapsedMs) => transcriptionSegmenter?.flushSilent(elapsedMs),
			);
			transcriptionSegmenter = new TranscriptionSegmenter(
				this.transcriptionApi,
				join(this.recordingsDir, command.sessionId),
				{
					guildId: command.guildId,
					channelId: command.channelId,
					sessionId: command.sessionId,
				},
				command.resume,
			);
			await this.sessionApi.markRecordingStarted(command.guildId, command.channelId, command.sessionId);
			recorder.start();

			this.activeRecordings.set(command.sessionId, { command, connection, recorder, transcriptionSegmenter, resumeInfo });
			logger.info(
				{ sessionId: command.sessionId, guildId: command.guildId, channelId: command.channelId, resumed: Boolean(resumeInfo) },
				'Recording started',
			);
		} catch (error) {
			if (recorder) {
				await recorder.stop().catch((stopError: unknown) => {
					logger.error({ err: stopError, sessionId: command.sessionId }, 'Recorder cleanup after startup failure failed');
				});
			}
			await transcriptionSegmenter?.finish().catch(() => undefined);
			connection?.destroy();
			throw error;
		}
	}

	private async stopRecording(recording: ActiveRecording): Promise<void> {
		if (recording.stopPromise) {
			await recording.stopPromise;
			return;
		}
		if (recording.failureToRecord) {
			await this.sessionApi.failSession(
				recording.command.guildId,
				recording.command.channelId,
				recording.command.sessionId,
				recording.failureToRecord,
			);
			this.activeRecordings.delete(recording.command.sessionId);
			return;
		}

		const stopPromise = (async () => {
			const { command, connection } = recording;
			let failSessionRecorded = false;
			try {
				await finalizeRecording(recording, this.sessionApi);
			} catch (error) {
				logger.error({ err: error, sessionId: command.sessionId }, 'Recording finalization failed');
				try {
					await this.sessionApi.failSession(command.guildId, command.channelId, command.sessionId, 'recording_finalize_failed');
					failSessionRecorded = true;
				} catch (failure) {
					recording.failureToRecord = 'recording_finalize_failed';
					throw failure;
				}
			} finally {
				connection.destroy();
				if (failSessionRecorded || !recording.failureToRecord) {
					this.activeRecordings.delete(command.sessionId);
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
}

function sameSession(left: GatewayCommand, right: GatewayCommand): boolean {
	return left.sessionId === right.sessionId && left.guildId === right.guildId && left.channelId === right.channelId;
}
