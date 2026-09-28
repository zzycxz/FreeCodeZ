import test from "node:test";
import assert from "node:assert/strict";
import { createRelayPairingStore } from "../src/main/webRemoteControl/pairing.js";

// pairing store 的常驻可达/自建中继读写（spec §1.10/§1.11）：默认值与持久化往返。

function createFakes(initial: Record<string, unknown> = {}) {
  let store = { ...initial };
  const settingService = {
    async get() {
      return store;
    },
    async update(patch: Record<string, unknown>) {
      store = { ...store, ...patch };
    },
  };
  const credentialService = {
    async load() {
      return undefined;
    },
    async save() {
      return undefined;
    },
    async delete() {
      return undefined;
    },
  };
  return { settingService, credentialService, snapshot: () => store };
}

function createLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test("readAutoEnabled 缺省 true（未停止过的用户默认常驻可达）", async () => {
  const fakes = createFakes();
  const store = createRelayPairingStore({
    credentialService: fakes.credentialService,
    settingService: fakes.settingService,
    logger: createLogger(),
  });
  assert.equal(await store.readAutoEnabled(), true);
  // 显式 false 持久化后读回 false。
  await store.writeAutoEnabled(false);
  assert.equal(await store.readAutoEnabled(), false);
  await store.writeAutoEnabled(true);
  assert.equal(await store.readAutoEnabled(), true);
});

test("writeAutoEnabled(false) 落 settings 键 webRemoteControlAutoEnabled", async () => {
  const fakes = createFakes();
  const store = createRelayPairingStore({
    credentialService: fakes.credentialService,
    settingService: fakes.settingService,
    logger: createLogger(),
  });
  await store.writeAutoEnabled(false);
  assert.equal(fakes.snapshot().webRemoteControlAutoEnabled, false);
});

test("readExternalRelayUrl 缺省空串；写入 trim；清空写回 undefined（回内嵌模式）", async () => {
  const fakes = createFakes();
  const store = createRelayPairingStore({
    credentialService: fakes.credentialService,
    settingService: fakes.settingService,
    logger: createLogger(),
  });
  assert.equal(await store.readExternalRelayUrl(), "");
  await store.writeExternalRelayUrl("  https://my-relay.example.com/  ");
  assert.equal(await store.readExternalRelayUrl(), "https://my-relay.example.com");
  await store.writeExternalRelayUrl("");
  assert.equal(await store.readExternalRelayUrl(), "");
  assert.equal(fakes.snapshot().webRemoteControlExternalRelayUrl, undefined);
});
