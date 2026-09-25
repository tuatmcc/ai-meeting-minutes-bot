const requiredVariables = ['DISCORD_APPLICATION_ID', 'DISCORD_TEST_GUILD_ID', 'DISCORD_BOT_TOKEN'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);
const invalidSnowflakes = ['DISCORD_APPLICATION_ID', 'DISCORD_TEST_GUILD_ID'].filter(
	(name) => process.env[name] && !/^\d{17,20}$/.test(process.env[name]),
);

if (missingVariables.length > 0) {
	console.error(`Missing required environment variables: ${missingVariables.join(', ')}`);
	process.exitCode = 1;
} else if (invalidSnowflakes.length > 0) {
	console.error(`Invalid Discord snowflake environment variables: ${invalidSnowflakes.join(', ')}`);
	process.exitCode = 1;
} else {
	const { DISCORD_APPLICATION_ID, DISCORD_TEST_GUILD_ID, DISCORD_BOT_TOKEN } = process.env;
	const commands = ['start', 'stop'].map((name) => ({
		name,
		description: name === 'start' ? 'VC の録音を開始します' : 'VC の録音を停止します',
		type: 1,
		options: [
			{
				name: 'channel',
				description: '対象のボイスチャンネル',
				type: 7,
				required: true,
				channel_types: [2],
			},
		],
	}));

	const response = await fetch(
		`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_TEST_GUILD_ID}/commands`,
		{
			method: 'PUT',
			headers: {
				Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(commands),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text();
		console.error(`Discord command registration failed (${response.status}): ${errorBody}`);
		process.exitCode = 1;
	} else {
		const registered = await response.json();
		console.log(`Registered ${Array.isArray(registered) ? registered.length : 0} guild commands.`);
	}
}
