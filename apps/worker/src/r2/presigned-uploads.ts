import { AwsClient } from 'aws4fetch';
import type { WorkerEnv } from '../env.js';
import type { VoiceSession } from '../sessions/types.js';

export type UploadTarget = {
	key: string;
	url: string;
	contentType: string;
};

const uploadTargets = [
	{ filename: 'recording.wav', contentType: 'audio/wav' },
	{ filename: 'manifest.json', contentType: 'application/json' },
] as const;

export async function createUploadTargets(env: WorkerEnv, session: VoiceSession): Promise<UploadTarget[]> {
	const client = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
	const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

	return Promise.all(
		uploadTargets.map(async ({ filename, contentType }) => {
			const key = filename === 'recording.wav' ? session.recordingKey : session.manifestKey;
			const encodedKey = key.split('/').map(encodeURIComponent).join('/');
			const url = new URL(`/${env.R2_BUCKET_NAME}/${encodedKey}`, endpoint);
			url.searchParams.set('X-Amz-Expires', '900');

			const signedRequest = await client.sign(
				new Request(url, {
					method: 'PUT',
					headers: { 'Content-Type': contentType },
				}),
				{ aws: { signQuery: true } },
			);

			return { key, url: signedRequest.url.toString(), contentType };
		}),
	);
}
