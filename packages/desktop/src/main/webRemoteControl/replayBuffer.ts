// 0C-4④：replay 缓冲已下沉 shared（createRelayReplayBuffer 同语义）。
export {
  createRelayReplayBuffer,
  type RelayReplayBuffer,
} from "@zcode/shared/web-remote-control";
export type EnqueueResult = { ok: true } | { ok: false; reason: "remote.rpcFrame.replayBufferExceeded" };
