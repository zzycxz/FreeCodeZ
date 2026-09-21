/* FreeCodeZ fork 惰性空壳(P2):该 UI 已随账号/闲时链下线;运行时行为等同删除,物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface InertOffPeakState { [k: string]: any }
const INERT: InertOffPeakState = {
  tasks: [], loading: false, grayConfig: undefined, codingPlanSupport: undefined,
  takeNumberAvailability: undefined, takeNumberAvailabilityStatus: "idle", operationId: null,
  refresh: async () => {}, refreshCodingPlanSupport: async () => {},
  refreshTakeNumberAvailability: async () => {},
  createTask: async () => ({ ok: false as const }), updateTask: async () => ({ ok: false as const }),
  pauseTask: async () => ({ ok: false as const }), continueTask: async () => ({ ok: false as const }),
  cancelTask: async () => ({ ok: false as const }), deleteTask: async () => ({ ok: false as const }),
  deleteHistory: async () => ({ ok: false as const }),
  consumePendingCreateDraft: () => undefined, pendingCreateDraft: null, error: null,
};
export const useOffPeakTaskStore = (<T>(selector: (s: any) => T): T => selector(INERT)) as any;
useOffPeakTaskStore.getState = () => INERT;
export function isCurrentOffPeakCodingPlanSupported(_a: unknown, _b: unknown): boolean {
  return false;
}
export function resolveOffPeakCreateErrorMessageId(_e: unknown): string {
  return "offPeak.create.failed";
}
