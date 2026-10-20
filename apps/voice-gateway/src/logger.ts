import pino from 'pino';

export const logger = pino({
	name: 'voice-gateway',
	level: process.env.LOG_LEVEL?.trim() || 'info',
	timestamp: pino.stdTimeFunctions.isoTime,
	redact: {
		paths: ['token', '*.token', 'interactionToken', '*.interactionToken'],
		censor: '[Redacted]',
	},
});
