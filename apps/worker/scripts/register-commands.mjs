const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN } = process.env;

if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN) {
	console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN before registering Discord commands.');
	process.exit(1);
}

if (!/^\d{17,20}$/.test(DISCORD_APPLICATION_ID)) {
	console.error('DISCORD_APPLICATION_ID must be a Discord snowflake.');
	process.exit(1);
}

const commands = [
	{
		name: 'start',
		description: 'このボイスチャンネルで録音を開始します',
		type: 1,
		options: [
			{
				name: 'notion_url',
				description: 'AI議事録を作成する既存のNotion議事録ページURL',
				type: 3,
				required: false,
				max_length: 2048,
			},
		],
	},
	{ name: 'stop', description: 'このボイスチャンネルの録音を停止します', type: 1 },
	{ name: 'imakita', description: '会議の現在地を短く要約します', type: 1 },
];

const response = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`, {
	method: 'PUT',
	headers: {
		Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
		'Content-Type': 'application/json',
	},
	body: JSON.stringify(commands),
});

if (!response.ok) {
	console.error(`Discord command registration failed (${response.status}): ${await response.text()}`);
	process.exit(1);
}

const registered = await response.json();
console.log(`Registered ${Array.isArray(registered) ? registered.length : 0} global Discord commands.`);
