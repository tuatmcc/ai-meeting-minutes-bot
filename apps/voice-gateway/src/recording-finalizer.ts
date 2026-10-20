import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GatewayCommand } from './clients/gateway-control.ts';
import { uploadToR2 } from './clients/r2-upload.ts';
import { SessionApi, type SessionResumeInfo } from './clients/session-api.ts';
import { TranscriptionSegmenter, type MeetingTranscription } from './clients/transcription-segmenter.ts';
import { VoiceRecorder } from './discord/voice-recorder.ts';
import { logger as baseLogger } from './logger.ts';

type RecordingToFinalize = {
	command: Extract<GatewayCommand, { action: 'start' }>;
	recorder: VoiceRecorder;
	transcriptionSegmenter: TranscriptionSegmenter;
	resumeInfo?: SessionResumeInfo;
};

const logger = baseLogger.child({ component: 'recording-finalizer' });

export async function finalizeRecording(recording: RecordingToFinalize, sessionApi: SessionApi): Promise<void> {
	const { command, recorder, transcriptionSegmenter, resumeInfo } = recording;
	const result = await recorder.stop().catch(async (error: unknown) => {
		await transcriptionSegmenter.finish().catch(() => undefined);
		throw error;
	});
	const currentTranscription = await transcriptionSegmenter.finish();
	const transcription = resumeInfo ? mergeTranscriptions(resumeInfo.manifest.transcription, currentTranscription) : currentTranscription;
	const durationMs = (resumeInfo?.manifest.durationMs ?? 0) + result.durationMs;
	logger.info(
		{
			sessionId: command.sessionId,
			framesReceived: result.stats.framesReceived,
			bytesReceived: result.stats.bytesReceived,
			durationMs: result.durationMs,
		},
		'Audio capture completed',
	);
	await sessionApi.markProcessingStarted(command.guildId, command.channelId, command.sessionId);
	const manifestPath = join(result.sessionDir, 'manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
	await writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				...manifest,
				startedAt: resumeInfo?.manifest.startedAt ?? manifest.startedAt,
				durationMs,
				transcription,
			},
			null,
			2,
		)}\n`,
		'utf8',
	);

	const uploads = await sessionApi.createUploadTargets(command.guildId, command.channelId, command.sessionId);
	const manifestUpload = uploads.find(({ key }) => key.endsWith('/manifest.json'));
	if (!manifestUpload) {
		throw new Error('Worker did not return an R2 manifest upload target');
	}

	const manifestSizeBytes = await uploadToR2(manifestUpload, manifestPath);
	await sessionApi.completeSession(command.guildId, command.channelId, command.sessionId, {
		endedAt: result.endedAt,
		durationMs,
		manifestSizeBytes,
	});
	logger.info({ sessionId: command.sessionId, model: transcription.model }, 'Transcription saved to R2');
	await rm(result.sessionDir, { recursive: true, force: true }).catch((error: unknown) => {
		logger.warn({ err: error, sessionId: command.sessionId }, 'Could not remove local temporary files');
	});
}

function mergeTranscriptions(previous: MeetingTranscription, current: MeetingTranscription): MeetingTranscription {
	return {
		model: current.model || previous.model,
		language: current.language ?? previous.language,
		text: [previous.text, current.text].filter(Boolean).join('\n'),
		segments: [...previous.segments, ...current.segments].sort((left, right) => left.startMs - right.startMs || left.index - right.index),
	};
}
