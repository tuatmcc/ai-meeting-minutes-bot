import type { APIEmbed } from 'discord-api-types/v10';
import type { WorkerEnv } from '../env.js';
import type { VoiceSession } from '../sessions/types.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export async function sendGatewayDisconnectedMessage(env: WorkerEnv, session: VoiceSession): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN) {
		console.error('[discord] cannot send gateway disconnect message: DISCORD_BOT_TOKEN is not configured');
		return;
	}

	const embed: APIEmbed = {
		title: 'Gateway 接続エラー',
		description: 'Gatewayとの制御接続が切断されたため、この録音を中断しました。録音は自動再開されません。',
		color: 0xed4245,
	};
	try {
		const response = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(session.channelId)}/messages`, {
			method: 'POST',
			headers: {
				Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ embeds: [embed] }),
		});
		if (!response.ok) {
			console.error('[discord] failed to send gateway disconnect message', { status: response.status, channelId: session.channelId });
		}
	} catch (error) {
		console.error('[discord] failed to send gateway disconnect message', {
			channelId: session.channelId,
			error: error instanceof Error ? error.name : 'unknown',
		});
	}
}
