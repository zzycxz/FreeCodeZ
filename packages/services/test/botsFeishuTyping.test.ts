// FreeCodeZ fork(Bots):飞书 typing = reaction（官方 addFeishuTypingReaction gZ @689778：
// POST `/open-apis/im/v1/messages/{id}/reactions` `{reaction_type:{emoji_type:"Typing"}}`，同消息去重；
// deleteFeishuTypingReaction Ode：DELETE `/reactions/{rid}`，无登记短路）+ taskBridge 取消时机（K）/G 守卫。
// 运行: node --import tsx --test packages/services/test/botsFeishuTyping.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import type { BotActor, BotConfig } from "@zcode/shared/bots";
import {
  createFeishuBotProvider,
  getFeishuTypingReactionKey,
} from "../src/bots/providers/feishuProvider.js";
import { BotTaskBridge } from "../src/bots/taskBridge.js";
import { BotsRepo } from "../src/bots/botsRepo.js";
import { BotResourceRegistry } from "../src/bots/resourceRegistry.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const feishuBot: BotConfig = {
  id: "fs-typing",
  name: "fs",
  provider: "feishu",
  enabled: true,
  credentialRef: "bot:fs-typing:credential",
  feishuAppId: "cli_0123456789abcdef",
  providerUserId: "ou_user",
  allowedWorkspaces: [],
  allowedCommands: {
    status: true,
    workspace: true,
    new: true,
    model: true,
    thoughtLevel: true,
    reply: true,
  },
  currentOptions: {},
  replyMode: "streaming_card",
};

function actorWith(messageId?: string): BotActor {
  return {
    provider: "feishu",
    botId: "fs-typing",
    providerUserId: "ou_user",
    chatType: "private",
    ...(messageId ? { providerMessageId: messageId } : {}),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function makeReactionRecorder(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload = url.includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "t-1", expire: 5400 }
      : (init?.method ?? "GET") === "POST" && url.includes("/reactions")
        ? { code: 0, data: { reaction_id: "r-1" } }
        : { code: 0, data: {} };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("feishu typing=reaction：POST Typing reaction + 同消息去重 + stopTyping DELETE reactions/{rid}", async () => {
  const { fetchImpl, calls } = makeReactionRecorder();
  const provider = createFeishuBotProvider({
    fetchImpl,
    credentialLoader: async () => "app-secret",
  });
  assert.equal(getFeishuTypingReactionKey(feishuBot, "om_typing_1"), "fs-typing:om_typing_1");

  await provider.sendTyping?.(feishuBot, actorWith("om_typing_1"));
  const add = calls.find((call) => call.url.includes("/reactions"));
  assert.ok(add, "sendTyping → POST /open-apis/im/v1/messages/{id}/reactions");
  assert.equal(add.method, "POST");
  assert.ok(add.url.includes("/open-apis/im/v1/messages/om_typing_1/reactions"), add.url);
  assert.deepEqual(add.body, { reaction_type: { emoji_type: "Typing" } });

  // 同消息去重（py.has 短路）：sendTyping/startTyping 重发不再 POST
  await provider.sendTyping?.(feishuBot, actorWith("om_typing_1"));
  await provider.startTyping?.(feishuBot, actorWith("om_typing_1"));
  assert.equal(
    calls.filter((call) => call.method === "POST" && call.url.includes("/reactions")).length,
    1,
    "同消息 reaction 去重",
  );

  // 取消时机（Ode）：DELETE /reactions/{reaction_id}；无登记短路
  await provider.stopTyping?.(feishuBot, actorWith("om_typing_1"));
  const remove = calls.find((call) => call.method === "DELETE" && call.url.includes("/reactions"));
  assert.ok(remove, "stopTyping → DELETE /reactions/{rid}");
  assert.ok(
    remove.url.includes("/open-apis/im/v1/messages/om_typing_1/reactions/r-1"),
    remove.url,
  );
  await provider.stopTyping?.(feishuBot, actorWith("om_typing_1"));
  assert.equal(
    calls.filter((call) => call.method === "DELETE").length,
    1,
    "无 reaction_id 登记时取消短路",
  );
});

test("feishu typing：无 providerMessageId 不挂 reaction；startTyping 同 sendTyping", async () => {
  const { fetchImpl, calls } = makeReactionRecorder();
  const provider = createFeishuBotProvider({
    fetchImpl,
    credentialLoader: async () => "app-secret",
  });
  await provider.sendTyping?.(feishuBot, actorWith());
  await provider.startTyping?.(feishuBot, actorWith());
  await provider.stopTyping?.(feishuBot, actorWith());
  assert.equal(calls.filter((call) => call.url.includes("/reactions")).length, 0);

  await provider.startTyping?.(feishuBot, actorWith("om_typing_2"));
  const add = calls.find((call) => call.method === "POST" && call.url.includes("/reactions"));
  assert.ok(add);
  assert.deepEqual(add.body, { reaction_type: { emoji_type: "Typing" } });
});

function makeBridge(options: {
  onTyping?: () => void;
  onStopTyping?: () => void;
}): BotTaskBridge {
  const taskService = {
    onDynamicTaskEvent() {
      return (_handler: (event: BotTaskStreamEvent) => void) => ({ dispose() {} });
    },
  } as unknown as BotTaskServiceLike;
  return new BotTaskBridge({
    taskService,
    repo: new BotsRepo({ configDir: process.env.TEMP ?? process.env.TMPDIR ?? "." }),
    resourceRegistry: new BotResourceRegistry(),
    sendOutbound: async () => undefined,
    sendTyping: async () => {
      options.onTyping?.();
    },
    stopTyping: async () => {
      options.onStopTyping?.();
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    now: () => 0,
    typingResendMs: 60_000,
  });
}

test("feishu typing 取消时机：taskBridge stop 句柄（官方 K）触发 stopTyping；G 守卫 hasTypingTargetFor", async () => {
  let stopped = 0;
  const bridge = makeBridge({
    onStopTyping: () => {
      stopped += 1;
    },
  });
  const stop = bridge.startTyping(feishuBot, actorWith("om_typing_3"), "task-1");
  // 官方 l 表登记：任务 typing 挂在 om_typing_3 → G（stopInboundTyping）跳过
  assert.equal(bridge.hasTypingTargetFor("fs-typing", "om_typing_3"), true);
  assert.equal(bridge.hasTypingTargetFor("fs-typing", "om_other"), false);
  assert.equal(bridge.hasTypingTargetFor("other-bot", "om_typing_3"), false);
  stop();
  assert.equal(stopped, 1, "stop 句柄触发 stopTyping（K）");
  assert.equal(bridge.hasTypingTargetFor("fs-typing", "om_typing_3"), false, "注销后 G 守卫放行");
  stop();
  assert.equal(stopped, 1, "stop 幂等");
});
