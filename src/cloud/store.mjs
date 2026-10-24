import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REQUEST_TTL_SECONDS = 120;
const HEARTBEAT_TTL_SECONDS = 120;

export class DynamoBroker {
  constructor({ tableName, client = DynamoDBDocumentClient.from(new DynamoDBClient({})) }) {
    if (!tableName) throw new Error("DynamoDB table name is required.");
    this.tableName = tableName;
    this.client = client;
  }

  key(userId, sortKey) {
    return { PK: `USER#${userId}`, SK: sortKey };
  }

  async heartbeat(userId, agentId) {
    const expiresAt = Math.floor(Date.now() / 1000) + HEARTBEAT_TTL_SECONDS;
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { ...this.key(userId, "AGENT#active"), agentId, expiresAt },
    }));
  }

  async activeAgent(userId) {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: this.key(userId, "AGENT#active"),
      ConsistentRead: true,
    }));
    return result.Item?.expiresAt > Math.floor(Date.now() / 1000) ? result.Item.agentId : null;
  }

  async createRequest(userId, agentId, tool, args) {
    const requestId = randomUUID();
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        ...this.key(userId, `REQ#${requestId}`),
        requestId,
        agentId,
        tool,
        args,
        status: "pending",
        expiresAt: Math.floor(Date.now() / 1000) + REQUEST_TTL_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    }));
    return requestId;
  }

  async claimNext(userId, agentId) {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      FilterExpression: "#status = :pending AND agentId = :agentId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":prefix": "REQ#",
        ":pending": "pending",
        ":agentId": agentId,
      },
      Limit: 25,
      ConsistentRead: true,
    }));
    for (const item of result.Items ?? []) {
      if (item.expiresAt <= Math.floor(Date.now() / 1000)) continue;
      try {
        await this.client.send(new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(userId, item.SK),
          UpdateExpression: "SET #status = :processing",
          ConditionExpression: "#status = :pending AND agentId = :agentId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":processing": "processing",
            ":agentId": agentId,
          },
        }));
        return { requestId: item.requestId, tool: item.tool, args: item.args };
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
      }
    }
    return null;
  }

  async completeRequest(userId, agentId, requestId, result) {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: this.key(userId, `REQ#${requestId}`),
      UpdateExpression: "SET #status = :complete, #result = :result",
      ConditionExpression: "#status = :processing AND agentId = :agentId",
      ExpressionAttributeNames: { "#status": "status", "#result": "result" },
      ExpressionAttributeValues: {
        ":processing": "processing",
        ":complete": "complete",
        ":agentId": agentId,
        ":result": result,
      },
    }));
  }

  async getRequest(userId, requestId) {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: this.key(userId, `REQ#${requestId}`),
      ConsistentRead: true,
    }));
    return result.Item ?? null;
  }

  async deleteRequest(userId, requestId) {
    await this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: this.key(userId, `REQ#${requestId}`),
    }));
  }
}
