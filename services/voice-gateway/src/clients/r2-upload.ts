import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { UploadTarget } from './session-api.js';

export async function uploadToR2(target: UploadTarget, filePath: string): Promise<number> {
	const { size } = await stat(filePath);
	return new Promise((resolve, reject) => {
		const upload = createReadStream(filePath);
		const request = httpsRequest(
			target.url,
			{
				method: 'PUT',
				headers: {
					'Content-Type': target.contentType,
					'Content-Length': size,
				},
			},
			(response) => {
				response.resume();
				response.once('end', () => {
					if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
						resolve(size);
						return;
					}
					reject(new Error(`R2 upload failed with HTTP ${response.statusCode ?? 'unknown'}`));
				});
			},
		);
		request.once('error', reject);
		upload.once('error', reject);
		upload.pipe(request);
	});
}
