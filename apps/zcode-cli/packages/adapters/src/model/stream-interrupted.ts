// 0C-3③（升级实施手册）：上游在 SSE 帧中间断流（连接被掐）时，流末尾会留下一个没有
// 分隔符的半帧。旧 compat 层把半帧当完整帧直通，下游 JSON 解析崩成
// InvalidModelResponse（不可重试）——网络中断被误标成模型坏响应。此错误让 compat 层的
// flush 以类型化失败终结流，分类器归为 network_error（可重试），流恢复链照常接管。
class ModelStreamInterruptedError extends Error {
  readonly code = "MODEL_STREAM_INTERRUPTED";
  readonly pendingBytes: number;

  constructor(options: { pendingBytes: number }) {
    super(
      `Model stream interrupted: connection ended inside an SSE frame ` +
        `(${options.pendingBytes} unterminated bytes).`,
    );
    this.name = "ModelStreamInterruptedError";
    this.pendingBytes = options.pendingBytes;
  }
}

export function isModelStreamInterruptedError(
  error: unknown,
): error is ModelStreamInterruptedError {
  if (error instanceof ModelStreamInterruptedError) {
    return true;
  }
  // controller.error 会把错误包进流管道；按 code 字符串识别跨层形态。
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "MODEL_STREAM_INTERRUPTED"
  );
}

export function createModelStreamInterruptedError(options: {
  pendingBytes: number;
}): ModelStreamInterruptedError {
  return new ModelStreamInterruptedError(options);
}
