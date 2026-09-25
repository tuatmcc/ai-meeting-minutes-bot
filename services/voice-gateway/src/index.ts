import { Events, GatewayIntentBits, Client } from 'discord.js';
import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { loadConfig } from './config.js';
import { VoiceRecorder } from './discord/voice-recorder.js';

const config = loadConfig();
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let stopping = false;
let stopRecording: (() => Promise<void>) | undefined;

client.once(Events.ClientReady, async (readyClient) => {
	const guild = await readyClient.guilds.fetch(config.guildId);
	const channel = await guild.channels.fetch(config.voiceChannelId);
	if (!channel?.isVoiceBased()) {
		throw new Error(`Channel ${config.voiceChannelId} is not a voice channel`);
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

	await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
	console.log(`[voice] connected to ${guild.name} / ${channel.name}`);

	const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
	const recorder = await VoiceRecorder.create(connection.receiver, config.recordingsDir, sessionId);
	recorder.start();
	console.log(`[recording] started: ${sessionId}`);

	stopRecording = async () => {
		if (stopping) {
			return;
		}
		stopping = true;

		const result = await recorder.stop();
		console.log(`[recording] saved: ${result.filePath}`);
		console.log(`[recording] manifest: ${config.recordingsDir}/${sessionId}/manifest.json`);
		console.log(`[recording] frames=${result.stats.framesWritten} late=${result.stats.lateFramesDropped}`);

		connection.destroy();
		await client.destroy();
	};

	setTimeout(() => {
		void stopRecording?.();
	}, config.recordSeconds * 1000).unref();
});

client.on(Events.Error, (error) => {
	console.error('[discord] client error', error);
});

process.once('SIGINT', () => {
	void stopRecording?.();
});

await client.login(config.token);
