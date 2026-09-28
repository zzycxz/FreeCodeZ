// 协议/桥层通用回调注册小工具：统一 dispose 语义，监听器异常不影响状态机。

export interface Listener<T> {
  callback: (value: T) => void;
}

export function createDispose<T>(
  set: Set<Listener<T>>,
  listener: Listener<T>,
): { dispose(): void } {
  set.add(listener);
  return {
    dispose: () => {
      set.delete(listener);
    },
  };
}
