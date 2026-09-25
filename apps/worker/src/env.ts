export type WorkerEnv = Env & {
	GATEWAY_API_TOKEN: string;
	GATEWAY_CONTROL_TOKEN: string;
	DISCORD_APPLICATION_ID: string;
	DISCORD_APPLICATION_PUBLIC_KEY: string;
	GATEWAY_CONTROL: DurableObjectNamespace<import('./control/gateway-control.js').GatewayControl>;
	R2_ACCOUNT_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
};
