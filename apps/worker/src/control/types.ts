export type GatewayCommand = {
	commandId: string;
	action: 'start' | 'stop';
	guildId: string;
	channelId: string;
	sessionId: string;
};

export type GatewayEnqueueResult = {
	gatewayConnected: boolean;
};
