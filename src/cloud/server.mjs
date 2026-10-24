import { createApp } from "./app.mjs";
import { createAuthenticator } from "./auth.mjs";
import { DynamoBroker } from "./store.mjs";

const env = process.env;
const app = createApp({
  broker: new DynamoBroker({ tableName: env.BROKER_TABLE }),
  authenticate: createAuthenticator({
    userPoolId: env.COGNITO_USER_POOL_ID,
    mcpClientId: env.COGNITO_MCP_CLIENT_ID,
    companionClientId: env.COGNITO_COMPANION_CLIENT_ID,
  }),
  issuer: env.COGNITO_ISSUER,
  publicOrigin: env.PUBLIC_ORIGIN,
});

app.listen(Number(env.PORT ?? 3000), "0.0.0.0", () => {
  process.stderr.write("RecruitSage cloud MCP listening\n");
});
