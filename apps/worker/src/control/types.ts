type BaseGatewayCommand = {
	commandId: string;
	guildId: string;
	channelId: string;
	sessionId: string;
};

export type GatewayCommand = BaseGatewayCommand &
	(
		| { action: 'start'; resume?: { segmentIndexOffset: number; timeOffsetMs: number } }
		| { action: 'stop' }
		| { action: 'imakita'; applicationId: string; interactionToken: string }
	);

export type GatewayEnqueueResult = {
	gatewayConnected: boolean;
};
