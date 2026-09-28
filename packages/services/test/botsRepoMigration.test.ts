// FreeCodeZ fork(Bots):迁移链 v1/v2→v3 + migrateSelection（附录B §5.5）。
// 运行: node --test packages/services/test/botsRepoMigration.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotsRepo,
  importLegacyBotConfig,
  importLegacyBotState,
  migrateSelection,
} from "../src/bots/botsRepo.js";

const LEGACY_BOT = {
  id: "bot-1",
  name: "  legacy bot  ",
  provider: "telegram",
  enabled: true,
  allowedWorkspaces: [" ", "ws-1", "ws-1", "*"],
  allowedCommands: { status: false, new: undefined },
  currentOptions: {
    model: "openai/gpt-4o",
    thoughtLevel: "high",
    mode: "yolo",
    junk: true,
  },
  replyMode: "assistant_changes",
};

/** 合法 v3 bot（RMW 测试用；legacy 归一化路径另测）。 */
function makeBot(id: string) {
  return {
    id,
    name: id,
    provider: "telegram" as const,
    enabled: true,
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
    replyMode: "assistant_changes" as const,
  };
}

test("migrateSelection：旧 {model, thoughtLevel} → 首个 / 切分 + 白名单 + reasoningLevel", () => {
  assert.deepEqual(migrateSelection({ model: "openai/gpt-4o", thoughtLevel: "high" }), {
    providerId: "openai",
    modelId: "gpt-4o",
    options: { reasoningLevel: "high" },
  });
  // 无 thoughtLevel → 无 options
  assert.deepEqual(migrateSelection({ model: "glm/glm-5" }), {
    providerId: "glm",
    modelId: "glm-5",
  });
  // 未知 provider 白名单拒绝 → undefined
  assert.equal(migrateSelection({ model: "unknownprov/m-1" }), undefined);
  // 无 / 分隔 → undefined
  assert.equal(migrateSelection({ model: "no-slash" }), undefined);
});

test("migrateSelection：modelSelection 直通；builtin:* 走映射表", () => {
  const direct = { providerId: "anthropic", modelId: "claude-x", options: { reasoningLevel: "low" } };
  assert.deepEqual(migrateSelection({ modelSelection: direct }), direct);
  assert.deepEqual(migrateSelection({ modelSelection: { providerId: "builtin:openai", modelId: "gpt-4o" } }), {
    providerId: "openai",
    modelId: "gpt-4o",
  });
  assert.deepEqual(migrateSelection({ modelSelection: { providerId: "builtin:glm", modelId: "glm-5" } }), {
    providerId: "glm",
    modelId: "glm-5",
  });
  // builtin 未知映射 → undefined；非法 modelSelection → undefined
  assert.equal(migrateSelection({ modelSelection: { providerId: "builtin:nope", modelId: "m" } }), undefined);
  assert.equal(migrateSelection({ modelSelection: { providerId: "", modelId: "" } }), undefined);
});

test("importLegacyBotConfig：currentOptions 归一 + version 3", () => {
  const migrated = importLegacyBotConfig({ bots: [LEGACY_BOT] }) as {
    version: number;
    bots: Array<Record<string, unknown>>;
  };
  assert.equal(migrated.version, 3);
  const currentOptions = migrated.bots[0]?.currentOptions as Record<string, unknown>;
  assert.deepEqual(currentOptions.modelSelection, {
    providerId: "openai",
    modelId: "gpt-4o",
    options: { reasoningLevel: "high" },
  });
  assert.equal(currentOptions.mode, "yolo");
});

test("importLegacyBotState：draftOptions → provider glm + migrateSelection + mode 保留", () => {
  const migrated = importLegacyBotState({
    bots: {
      "bot-1": {
        botId: "bot-1",
        workspacePath: "/w",
        mode: "draft",
        activeTaskId: null,
        updatedAt: 1,
        draftOptions: { model: "openai/gpt-4o", thoughtLevel: "high", mode: "plan" },
      },
    },
  }) as { version: number; bots: Record<string, { draftOptions: Record<string, unknown> }> };
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.bots["bot-1"]?.draftOptions, {
    provider: "glm",
    modelSelection: {
      providerId: "openai",
      modelId: "gpt-4o",
      options: { reasoningLevel: "high" },
    },
    mode: "plan",
  });
});

test("BotsRepo 迁移链：v3 无 → bot-config.json / bot-state.v2.json(优先) / bot-state.json 并回写 v3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-migrate-"));
  try {
    await writeFile(
      join(dir, "bot-config.json"),
      JSON.stringify({ bots: [LEGACY_BOT] }),
      "utf8",
    );
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify({
        bots: {
          "bot-1": {
            botId: "bot-1",
            workspacePath: "/w",
            mode: "draft",
            activeTaskId: null,
            updatedAt: 1,
            draftOptions: { model: "glm/glm-5" },
          },
        },
      }),
      "utf8",
    );
    // v1 同时存在时应被 v2 覆盖（优先 v2）
    await writeFile(
      join(dir, "bot-state.json"),
      JSON.stringify({
        bots: {
          "bot-1": { botId: "bot-1", workspacePath: "/legacy-v1", mode: "draft", activeTaskId: null, updatedAt: 1 },
        },
      }),
      "utf8",
    );

    const repo = new BotsRepo({ configDir: dir });
    const config = await repo.readConfig();
    assert.equal(config.version, 3);
    const bot = config.bots[0];
    assert.ok(bot);
    assert.equal(bot.name, "legacy bot");
    assert.deepEqual(bot.allowedWorkspaces, ["*"]);
    assert.deepEqual(bot.currentOptions.modelSelection, {
      providerId: "openai",
      modelId: "gpt-4o",
      options: { reasoningLevel: "high" },
    });

    const state = await repo.readState();
    assert.equal(state.version, 3);
    assert.equal(state.bots["bot-1"]?.workspacePath, "/w");
    assert.deepEqual(state.bots["bot-1"]?.draftOptions, {
      provider: "glm",
      modelSelection: { providerId: "glm", modelId: "glm-5" },
    });

    // v3 已回写（JSON.stringify(x,null,2)+"\n"）
    const written = await readFile(join(dir, "bot-config.v3.json"), "utf8");
    assert.ok(written.endsWith("\n"));
    assert.ok(written.includes('"version": 3'));
    await readFile(join(dir, "bot-state.v3.json"), "utf8");

    // v3 存在时不再读 legacy
    const again = await repo.readConfig();
    assert.equal(again.bots[0]?.id, "bot-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BotsRepo：全新目录 → 空 v3；RMW 串行不丢更新（R14）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-fresh-"));
  try {
    const repo = new BotsRepo({ configDir: dir });
    const empty = await repo.readConfig();
    assert.deepEqual(empty, { version: 3, bots: [] });

    // 并发 updateConfig 全部命中（跨操作锁串行化，不丢更新）
    await Promise.all([
      repo.updateConfig((config) => ({ ...config, bots: [...config.bots, makeBot("a")] })),
      repo.updateConfig((config) => ({ ...config, bots: [...config.bots, makeBot("b")] })),
      repo.updateConfig((config) => ({ ...config, bots: [...config.bots, makeBot("c")] })),
    ]);
    const config = await repo.readConfig();
    assert.deepEqual(
      config.bots.map((bot) => bot.id).sort(),
      ["a", "b", "c"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
