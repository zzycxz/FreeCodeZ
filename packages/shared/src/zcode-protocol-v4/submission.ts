import { z } from "zod";

/** Composer 可以显式提交的 Agent mode；auto 是 Runtime 内部状态，不进入用户 Submission。
 *  guarded=自主模式（U2-1：危险命令执行前单次确认）。 */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "guarded"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
