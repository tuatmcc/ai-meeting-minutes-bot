import { createUploadTargets } from '../r2/presigned-uploads.js';
import type { WorkerEnv } from '../env.js';
import type { SessionOperation } from '../sessions/types.js';

const API_PREFIX = '/api/v1';
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{17,20})$/i;

export async function handleSessionApi(request: Request, env: WorkerEnv): Promise<Response> {
	try {
		return await routeSessionApi(request, env);
	} catch (error) {
		console.error('[session-api] request failed', error instanceof Error ? error.name : 'unknown error');
		return json({ error: { code: 'INTERNAL_ERROR' } }, 500);
	}
}

async function routeSessionApi(request: Request, env: WorkerEnv): Promise<Response> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
		return json({ error: { code: 'NOT_FOUND' } }, 404);
	}
	if (!(await isAuthorized(request, env.GATEWAY_API_TOKEN))) {
		return json({ error: { code: 'UNAUTHORIZED' } }, 401);
	}

	const segments = url.pathname.split('/').filter(Boolean);
	if (
		segments[0] !== 'api' ||
		segments[1] !== 'v1' ||
		segments[2] !== 'guilds' ||
		segments[4] !== 'voice-channels' ||
		segments[6] !== 'sessions'
	) {
		return json({ error: { code: 'NOT_FOUND' } }, 404);
	}

	const guildId = segments[3];
	const channelId = segments[5];
	if (!SNOWFLAKE_PATTERN.test(guildId) || !SNOWFLAKE_PATTERN.test(channelId)) {
		return json({ error: { code: 'INVALID_CHANNEL' } }, 400);
	}

	const session = env.VOICE_CHANNEL_SESSION.getByName(`${guildId}:${channelId}`);
	if (request.method === 'GET' && segments.length === 8 && segments[7] === 'active') {
		return json({ session: await session.getActiveSession() });
	}

	if (request.method === 'POST' && segments.length === 7) {
		const requestId = request.headers.get('Idempotency-Key') ?? '';
		if (!IDEMPOTENCY_KEY_PATTERN.test(requestId)) {
			return json({ error: { code: 'INVALID_IDEMPOTENCY_KEY' } }, 400);
		}
		return operationResponse(await session.startSession(guildId, channelId, requestId), 201);
	}

	if (request.method !== 'POST' || segments.length !== 9 || !UUID_PATTERN.test(segments[7])) {
		return json({ error: { code: 'NOT_FOUND' } }, 404);
	}

	const sessionId = segments[7];
	switch (segments[8]) {
		case 'recording-started':
			return operationResponse(await session.markRecordingStarted(sessionId));
		case 'processing-started':
			return operationResponse(await session.markProcessingStarted(sessionId));
		case 'upload-targets': {
			const result = await session.reserveUpload(sessionId);
			if (!result.ok) {
				return operationResponse(result);
			}
			return json({ session: result.session, uploads: await createUploadTargets(env, result.session) });
		}
		case 'completed': {
			const body = await parseJson(request);
			if (!isCompletionBody(body)) {
				return json({ error: { code: 'INVALID_BODY' } }, 400);
			}
			return operationResponse(
				await session.completeSession(sessionId, {
					endedAt: body.endedAt,
					durationMs: body.durationMs,
					manifestSizeBytes: body.manifestSizeBytes,
				}),
			);
		}
		case 'failed': {
			const body = await parseJson(request);
			if (!isErrorCodeBody(body)) {
				return json({ error: { code: 'INVALID_BODY' } }, 400);
			}
			return operationResponse(await session.failSession(sessionId, body.errorCode));
		}
		default:
			return json({ error: { code: 'NOT_FOUND' } }, 404);
	}
}

async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
	if (!expectedToken) {
		return false;
	}
	const authorization = request.headers.get('Authorization') ?? '';
	const providedToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
	const encoder = new TextEncoder();
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(providedToken)),
		crypto.subtle.digest('SHA-256', encoder.encode(expectedToken)),
	]);
	return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function parseJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

function isCompletionBody(value: unknown): value is { endedAt: string; durationMs: number; manifestSizeBytes: number } {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const body = value as Record<string, unknown>;
	return (
		typeof body.endedAt === 'string' &&
		Number.isFinite(Date.parse(body.endedAt)) &&
		typeof body.durationMs === 'number' &&
		Number.isFinite(body.durationMs) &&
		body.durationMs >= 0 &&
		typeof body.manifestSizeBytes === 'number' &&
		Number.isSafeInteger(body.manifestSizeBytes) &&
		body.manifestSizeBytes > 0
	);
}

function isErrorCodeBody(value: unknown): value is { errorCode: string } {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const errorCode = (value as Record<string, unknown>).errorCode;
	return typeof errorCode === 'string' && /^[a-z0-9_-]{1,80}$/.test(errorCode);
}

function operationResponse(result: SessionOperation, successStatus = 200): Response {
	if (result.ok) {
		return json({ session: result.session }, successStatus);
	}
	const status = result.code === 'SESSION_NOT_FOUND' ? 404 : 409;
	return json({ error: { code: result.code }, ...(result.session ? { session: result.session } : {}) }, status);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}
