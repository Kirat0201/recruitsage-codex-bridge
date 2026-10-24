import { CognitoJwtVerifier } from "aws-jwt-verify";

export function createAuthenticator({ userPoolId, mcpClientId, companionClientId }) {
  if (!userPoolId || !mcpClientId || !companionClientId) {
    throw new Error("Cognito user pool and both app client IDs are required.");
  }
  const verifiers = {
    mcp: CognitoJwtVerifier.create({ userPoolId, tokenUse: "access", clientId: mcpClientId }),
    companion: CognitoJwtVerifier.create({ userPoolId, tokenUse: "access", clientId: companionClientId }),
  };
  return async (authorization, audience) => {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/.exec(authorization ?? "");
    if (!match || !verifiers[audience]) return null;
    try {
      const claims = await verifiers[audience].verify(match[1]);
      if (!claims.sub) return null;
      return { userId: claims.sub };
    } catch {
      return null;
    }
  };
}
