# AWS hosted MCP deployment

## What runs where

- **Laptop:** Playwright opens a dedicated RecruitSage browser. RecruitSage sign-in, cookies, session tokens, and the Chromium profile remain on that laptop. The companion signs in separately to AWS Cognito using authorization code plus PKCE and holds its AWS access token only in process memory.
- **AWS:** App Runner serves a public HTTPS MCP endpoint. Cognito verifies a separate token for each user and a separate client ID for the MCP client and companion. DynamoDB temporarily holds pending tool requests and returned job text, partitioned by verified Cognito user ID. Requests are deleted after delivery; TTL is a fallback, not an immediate deletion guarantee. DynamoDB service encryption protects stored items.
- **MCP client/chat:** Eligible job text and PDF text returned by the tool enter the connected MCP client's conversation.

The cloud exposes only `list_eligible_jobs` and `get_job_description`. The local browser process has additional read-only inspection tools, but the companion does not forward them. Job eligibility comes from the portal's **Open to you** tab.

## Deployment status

The source, container recipe, and CloudFormation templates are prepared. A live AWS deployment and OAuth handshake have **not** been verified. AWS CLI/account access and the selected MCP client's exact OAuth callback URL are required to finish. Keep the Cognito user pool invite-only until that verification is complete.

## AWS steps

1. Choose an AWS region. Configure AWS CLI with your own AWS SSO or IAM Identity Center session on your machine. Never paste access keys or RecruitSage credentials into a chat, repository, or environment file committed to Git.
2. Deploy `infra/bootstrap.yaml`. It creates a private `recruitsage-mcp` ECR repository with immutable tags and image scanning.
3. Build the image from the repo root: `docker build -t recruitsage-mcp:reviewed .`. The Docker context excludes `.playwright-profile`, `.env*`, project outputs, and the local browser source. Inspect `docker history` and the build context before upload.
4. Push the reviewed image to the ECR repository and use its immutable `repository@sha256:...` digest as `ImageIdentifier` for `infra/aws.yaml`.
5. Get the exact OAuth redirect URI for the MCP client you plan to connect. Use it as `McpCallbackUrl`. Deploy `infra/aws.yaml` with a temporary `PublicOrigin` of `https://bootstrap.invalid`; then update the same stack with `https://` plus the returned `ServiceUrl`. This two-step update is required because App Runner generates its hostname on creation.
6. Invite a test user into the Cognito user pool. Configure that MCP client to authenticate with the **MCP app client ID** and connect to `https://SERVICE_URL/mcp`. Configure the laptop companion with the **companion app client ID**. Both Cognito tokens must represent the same Cognito user.
7. Confirm the `/mcp` endpoint challenges unauthenticated requests, the companion can sign in, and only the signed-in portal's **Open to you** rows appear. Verify cross-user isolation with two test accounts before inviting anyone else.

Example companion environment (values are public configuration, not RecruitSage credentials):

```sh
export RECRUITSAGE_CLOUD_URL="https://SERVICE_URL/mcp"
export COGNITO_DOMAIN="https://YOUR_PREFIX.auth.YOUR_REGION.amazoncognito.com"
export COGNITO_COMPANION_CLIENT_ID="YOUR_COMPANION_APP_CLIENT_ID"
npm run companion
```

The Cognito companion client must allow the exact loopback callback `http://127.0.0.1:48731/callback`. Cognito sign-in opens the user's default browser. The RecruitSage browser opens on the first job request; the student signs in there. The companion asks for Cognito sign-in again when its one-hour token expires. It does not persist the AWS token.

## Security and operating limits

- The Cognito pool currently disables self-registration. An administrator must invite users. This keeps the first deployment limited while usage and abuse controls are tested.
- Cloud access uses individual short-lived JWTs; no shared static API token exists. A stolen valid bearer token could be used until it expires or is revoked, so users must keep their local machine and MCP client configuration secure.
- The App Runner template caps scale at two instances, but AWS still charges for App Runner, DynamoDB, Cognito, data transfer, and image storage. Set an AWS Budget and billing alerts before opening access beyond test users.
- The job and PDF text briefly persists in DynamoDB during each request. TTL removal is asynchronous; the application explicitly deletes completed requests after the MCP response. AWS service operators still process this data. Do not describe the data path as transit-only.
- The service currently accepts only one active companion per Cognito user. A second companion replaces the first heartbeat; avoid running two laptops simultaneously under the same user.
- This repository has no AWS credentials and cannot deploy without an authorized AWS session. The hosted OAuth flow depends on the chosen MCP client's callback and discovery behavior and needs a live integration test before public use.
