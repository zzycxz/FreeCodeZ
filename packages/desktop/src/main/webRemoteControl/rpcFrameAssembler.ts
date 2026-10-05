// 0C-4④：rpc-frame 重组器已下沉 shared（createRelayFrameAssembler 同语义）。
// 旧导出名 RpcFrameAssembler* 保留别名，消费方零改动。
export {
  createRelayFrameAssembler as createRpcFrameAssembler,
  type RelayFrameAssemblerOptions as RpcFrameAssemblerOptions,
} from "@zcode/shared/web-remote-control";
import type { RpcFrame } from "@zcode/shared/web-remote-control";

export interface RpcFrameAssembler {
  acceptFrame(frame: RpcFrame): boolean;
  sweepStale(): void;
  reset(): void;
}
