// Elicitation 多问题表单状态机（附录B §2.3）：
// 哨兵 __custom__（展开自定义）、__submit__（多选完成）、__skip__[:token]（单选跳过）、
// __form__:+encodeURIComponent(JSON)（飞书表单 merge）；token = sha256(taskId::runId::requestId::qIndex).hex.slice(0,12)。
// 非 weixin 应答必须带 12hex token；文本多选按 [,\n，、] 切分。
import { createHash } from "node:crypto";
import type {
  BotActor,
  BotSelection,
  ElicitationView,
  PendingElicitation,
  SelectionOption,
} from "@zcode/shared/bots";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";
import { markCurrentSelection } from "./replyPipeline.js";

export const ELICITATION_CUSTOM_OPTION = "__custom__";
export const ELICITATION_SUBMIT_OPTION = "__submit__";
export const ELICITATION_SKIP_OPTION = "__skip__";
export const ELICITATION_FORM_PREFIX = "__form__:";

export interface ElicitationQuestionInput {
  question: string;
  header: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface ElicitationRequestLike {
  taskId: string;
  traceId: string;
  requestId: string;
  origin?: string;
  message: string;
  header?: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
  questions?: ElicitationQuestionInput[];
  schema?: unknown;
}

export interface PlanApprovalSchema {
  interaction: "plan_approval";
  plan: string;
}

export function getPendingElicitationSelectionToken(pending: Pick<
  PendingElicitation,
  "taskId" | "runId" | "requestId" | "currentQuestionIndex"
>): string {
  return createHash("sha256")
    .update(
      [pending.taskId, pending.runId, pending.requestId, pending.currentQuestionIndex].join("::"),
    )
    .digest("hex")
    .slice(0, 12);
}

export function getPendingElicitationSkipOptionId(
  pending: Pick<PendingElicitation, "taskId" | "runId" | "requestId" | "currentQuestionIndex">,
): string {
  return `${ELICITATION_SKIP_OPTION}:${getPendingElicitationSelectionToken(pending)}`;
}

/** actorKey = `botId::provider::chat??user`（pendingElicitation 归属判定）。 */
export function getActorKey(actor: Pick<BotActor, "botId" | "provider" | "chatId" | "providerUserId">): string {
  return [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId].join("::");
}

export function isPendingElicitationOwnedByActor(
  pending: Pick<PendingElicitation, "actorKey">,
  actor: BotActor,
): boolean {
  return !pending.actorKey || pending.actorKey === getActorKey(actor);
}

export function readBotElicitationRenderContext(
  request: ElicitationRequestLike,
): PlanApprovalSchema | undefined {
  const schema = request.schema;
  if (
    typeof schema === "object" &&
    schema !== null &&
    (schema as PlanApprovalSchema).interaction === "plan_approval" &&
    typeof (schema as PlanApprovalSchema).plan === "string" &&
    (schema as PlanApprovalSchema).plan.trim()
  ) {
    return { interaction: "plan_approval", plan: (schema as PlanApprovalSchema).plan.trim() };
  }
  return undefined;
}

export function createPendingElicitationSchema(
  pending: Pick<PendingElicitation, "renderContext">,
): PlanApprovalSchema | undefined {
  return pending.renderContext?.kind === "plan_approval"
    ? { interaction: "plan_approval", plan: pending.renderContext.plan }
    : undefined;
}

/** schema 形态 → 持久化 renderContext 形态（{kind:'plan_approval', plan}）。 */
export function toPendingElicitationRenderContext(
  schema: PlanApprovalSchema,
): NonNullable<PendingElicitation["renderContext"]> {
  return { kind: "plan_approval", plan: schema.plan };
}

/** normalizeBotElicitationQuestions（R4）：plan_approval → 单题批准；否则 questions 或 message 兜底。 */
export function normalizeBotElicitationQuestions(
  request: ElicitationRequestLike,
  locale: BotHostLocale | undefined,
): ElicitationQuestionInput[] {
  const renderContext = readBotElicitationRenderContext(request);
  if (renderContext) {
    return [
      {
        question: formatBotMessage(locale, "planApprovalTitle"),
        header: formatBotMessage(locale, "planApprovalHeader"),
        options: [
          {
            value: "approve",
            label: formatBotMessage(locale, "planApprovalApprove"),
            description: formatBotMessage(locale, "planApprovalApproveDescription"),
          },
        ],
      },
    ];
  }
  const source: ElicitationQuestionInput[] =
    request.questions && request.questions.length > 0
      ? request.questions
      : [
          {
            question: request.message,
            header: request.header ?? request.message,
            options: request.options,
            ...(request.multiSelect ? { multiSelect: true } : {}),
          },
        ];
  return source.map((question) => ({
    question: question.question,
    header: question.header || question.question,
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label || option.value,
      ...(option.description ? { description: option.description } : {}),
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}

export function readElicitationAnswerValues(
  pending: Pick<PendingElicitation, "answers">,
  questionIndex: number,
): string[] {
  return pending.answers[String(questionIndex)] ?? [];
}

/** parseElicitationResponseValue（A4）：行首 12hex token 分离。 */
export function parseElicitationResponseValue(value: string): { token?: string; value: string } {
  const trimmed = value.trim();
  const [head, ...rest] = trimmed.split(/\s+/u);
  if (head && rest.length > 0 && /^[a-f0-9]{12}$/iu.test(head)) {
    return { token: head.toLowerCase(), value: rest.join(" ") };
  }
  return { value: trimmed };
}

/** parseElicitationFormValues（E4）：`__form__:` + encodeURIComponent(JSON)。 */
export function parseElicitationFormValues(value: string): string[] | null {
  if (!value.startsWith(ELICITATION_FORM_PREFIX)) return null;
  const body = value.slice(ELICITATION_FORM_PREFIX.length);
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(body));
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** mergeElicitationFormValues（T4）：单选取首个；多选去重合并（旧值优先）。 */
export function mergeElicitationFormValues(
  question: Pick<ElicitationQuestionInput, "multiSelect">,
  previous: readonly string[],
  incoming: readonly string[],
): string[] {
  const next = incoming.filter(Boolean);
  if (!question.multiSelect) return next.length > 0 ? next.slice(0, 1) : previous.slice(0, 1);
  const merged: string[] = [];
  for (const value of [...previous, ...next]) {
    if (value && !merged.includes(value)) merged.push(value);
  }
  return merged;
}

export function getElicitationAnswerKey(questionIndex: number): string {
  return String(questionIndex);
}

/** resolveElicitationQuestionValue（Qv）：submit 词/序号 → __submit__；命中 id/label → value；否则自定义文本。 */
export function resolveElicitationQuestionValue(
  question: ElicitationQuestionInput,
  text: string,
  options: { includeSubmit?: boolean } = {},
): string {
  const normalized = text.trim();
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  const submitTokens = ["submit", "done", "完成", "提交", ELICITATION_SUBMIT_OPTION];
  if (question.multiSelect && options.includeSubmit !== false && submitTokens.includes(lowered)) {
    return ELICITATION_SUBMIT_OPTION;
  }
  const byIdOrLabel =
    question.options.find(
      (option) =>
        option.value.toLowerCase() === lowered || option.label.toLowerCase() === lowered,
    ) ?? null;
  if (byIdOrLabel) return byIdOrLabel.value;
  const asIndex = Number.parseInt(normalized, 10);
  if (
    question.multiSelect &&
    options.includeSubmit !== false &&
    /^[1-9]\d*$/u.test(normalized) &&
    asIndex === question.options.length + 1
  ) {
    return ELICITATION_SUBMIT_OPTION;
  }
  return normalized;
}

export function toggleElicitationCustomAnswerExpanded(
  pending: Pick<PendingElicitation, "expandedCustomAnswerQuestionIndexes">,
  questionIndex: number,
): PendingElicitation["expandedCustomAnswerQuestionIndexes"] {
  const expanded = new Set(pending.expandedCustomAnswerQuestionIndexes ?? []);
  if (expanded.has(questionIndex)) expanded.delete(questionIndex);
  else expanded.add(questionIndex);
  return [...expanded].sort((a, b) => a - b);
}

/** buildBotElicitationContent（YE）：提交 content = {answers, answer_<n>[, answer]}。 */
export function buildBotElicitationContent(
  pending: Pick<PendingElicitation, "questions">,
  answers: Record<string, string[]>,
): Record<string, unknown> {
  const pairs = pending.questions.flatMap((question, index) => {
    const joined = (answers[getElicitationAnswerKey(index)] ?? []).join(", ").trim();
    return joined ? [[question.question, joined] as const] : [];
  });
  const content: Record<string, unknown> = { answers: Object.fromEntries(pairs) };
  pending.questions.forEach((question, index) => {
    const values = answers[getElicitationAnswerKey(index)] ?? [];
    if (values.length > 0) {
      content[`answer_${index}`] = question.multiSelect ? values : values[0];
    }
  });
  if (pending.questions.length === 1) {
    const values = answers[getElicitationAnswerKey(0)] ?? [];
    if (values.length > 0) {
      content.answer = pending.questions[0]?.multiSelect ? values : values[0];
    }
  }
  return content;
}

/** formatBotElicitationTitle（O4）：plan 卡或多题序号/题面/提示拼接。 */
export function formatBotElicitationTitle(
  pending: PendingElicitation,
  locale: BotHostLocale | undefined,
): string {
  const question = pending.questions[pending.currentQuestionIndex] ?? pending.questions[0];
  if (!question) return pending.requestId;
  const customExpanded =
    pending.expandedCustomAnswerQuestionIndexes?.includes(pending.currentQuestionIndex) === true;
  if (pending.renderContext?.kind === "plan_approval") {
    return [
      pending.renderContext.plan,
      "------",
      formatBotMessage(locale, "planApprovalTitle"),
      customExpanded ? formatBotMessage(locale, "elicitationCustomPlaceholder") : null,
    ]
      .filter((line): line is string => typeof line === "string" && line.length > 0)
      .join("\n\n");
  }
  return [
    pending.questions.length > 1
      ? `${pending.currentQuestionIndex + 1}/${pending.questions.length}`
      : null,
    question.header && question.header !== question.question ? question.header : null,
    question.question,
    question.multiSelect ? formatBotMessage(locale, "elicitationMultiSelectHint") : null,
    customExpanded ? formatBotMessage(locale, "elicitationCustomPlaceholder") : null,
    formatBotMessage(locale, "elicitationTextHint"),
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

/** createBotElicitationSelection（D4）：多选 [x]/[ ] 前缀 + __submit__；单选 + __skip__[:token]；plan + __custom__。 */
export function createBotElicitationSelection(
  pending: PendingElicitation,
  locale: BotHostLocale | undefined,
): BotSelection {
  const question = pending.questions[pending.currentQuestionIndex];
  const selected = new Set(readElicitationAnswerValues(pending, pending.currentQuestionIndex));
  const options: SelectionOption[] =
    question?.options.map((option) => ({
      id: option.value,
      label: question.multiSelect
        ? `${selected.has(option.value) ? "[x]" : "[ ]"} ${option.label}`
        : option.label,
      ...(pending.renderContext?.kind === "plan_approval"
        ? {}
        : option.description
          ? { description: option.description }
          : {}),
    })) ?? [];
  if (pending.renderContext?.kind === "plan_approval") {
    options.push({ id: ELICITATION_CUSTOM_OPTION, label: formatBotMessage(locale, "elicitationCustomOption") });
  }
  if (question?.multiSelect) {
    options.push({ id: ELICITATION_SUBMIT_OPTION, label: formatBotMessage(locale, "elicitationSubmitOption") });
  } else if (question) {
    options.push({
      id: getPendingElicitationSkipOptionId(pending),
      label: formatBotMessage(locale, "elicitationSkipOption"),
    });
  }
  return markCurrentSelection(
    {
      id: `elicitation-${pending.requestId}-${pending.currentQuestionIndex}`,
      token: getPendingElicitationSelectionToken(pending),
      title: formatBotElicitationTitle(pending, locale),
      action: "elicitation.respond",
      options,
    },
    locale,
  );
}

/** createElicitationView（Us 的 elicitation 载荷）。 */
export function createElicitationView(
  pending: PendingElicitation,
  status: ElicitationView["status"],
): ElicitationView {
  const questionIndex =
    status === "pending"
      ? pending.currentQuestionIndex
      : Math.max(0, pending.questions.length - 1);
  return {
    requestId: pending.requestId,
    taskId: pending.taskId,
    runId: pending.runId,
    currentQuestionIndex: questionIndex,
    questions: pending.questions,
    answers: pending.answers,
    status,
    ...(pending.expandedCustomAnswerQuestionIndexes?.length
      ? { expandedCustomAnswerQuestionIndexes: pending.expandedCustomAnswerQuestionIndexes }
      : {}),
    ...(createPendingElicitationSchema(pending) ? { schema: createPendingElicitationSchema(pending) } : {}),
  };
}

/** createBotElicitationRequestSnapshot（x4）：广播/webhook 用。 */
export function createBotElicitationRequestSnapshot(pending: PendingElicitation): Record<string, unknown> {
  const question = pending.questions[pending.currentQuestionIndex] ?? pending.questions[0];
  const answerDrafts = Object.fromEntries(
    Object.entries(pending.answers).map(([key, values]) => [`answer_${key}`, values]),
  );
  return {
    type: "elicitation_request",
    taskId: pending.taskId,
    traceId: pending.runId,
    requestId: pending.requestId,
    ...(pending.origin ? { origin: pending.origin } : {}),
    message: question?.question ?? "",
    ...(question?.header ? { header: question.header } : {}),
    options: question?.options ?? [],
    ...(question?.multiSelect ? { multiSelect: true } : {}),
    questions: pending.questions,
    currentQuestionIndex: pending.currentQuestionIndex,
    answerDrafts,
    ...(createPendingElicitationSchema(pending) ? { schema: createPendingElicitationSchema(pending) } : {}),
  };
}
