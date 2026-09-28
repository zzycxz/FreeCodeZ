/* eslint-disable max-lines -- 14 工具 handler 与附录 A.1 方法映射同表对照;动作收据归一(possibly_sent 判定)是全表共享的语义,按工具拆分会把收据规则复制多份。 */
// B2 内部模块:14 工具 handler(附录 A.1 方法映射)。语义对齐官方 producer 的
// runClick/scroll/drag/keyboard/paste/request_access/stop 簇(node-repl-host 113700-115300);
// 简化点(差异说明入 docs/spec/computer-control-capability.md §10):
// 元素指纹只保留 native/身份两级匹配;expected_pid 从元素 owner_pid/帧身份/app_ref 取,
// 不做 capture_app 二次交叉核验。
import {
  effectEvidenceText,
  formatAppStateTree,
  jsonResult,
  textResult,
  toolError,
} from "./tool-envelope.js";
import {
  frameProvenanceFor,
  resolveCoordinateTarget,
  resolveElementTarget,
  TargetResolveError,
} from "./tool-session.js";
import { buildObservationContent, ingestCaptureAppResult } from "./tool-observation.js";
import { cuaRequestAccessStatusSchema, CUA_REQUEST_ACCESS_STATUS_META_KEY } from "../request-access-contract.js";

/** broker 动作响应 → 收据(缺 action_sent 的观测/元数据方法不算失败)。 */
function dispatchReceiptOf(result) {
  if (!result || typeof result !== "object") return {};
  const receipt = {};
  for (const key of [
    "action_sent",
    "dispatch_status",
    "state_sync_status",
    "resolved_app_ref",
    "dispatch_surface",
    "target_verification_status",
    "ax_error",
  ]) {
    if (result[key] !== undefined) receipt[key] = result[key];
  }
  return receipt;
}

/**
 * 动作失败 → 收据归一:只有 helper **明确回执**下发过(details.action_sent/dispatch_status)
 * 才置 action_sent:true(possibly_sent 的 actionSent 默认 false 是保守方向)。
 * transport 级断连(request_delivery_state=possibly_sent)不在这里吞——它必须上抛到策略层,
 * 归一 broker_response_ambiguous(A8 双路径之一)。
 */
function dispatchReceiptFromError(error) {
  const details = error?.details;
  if (!details || typeof details !== "object") return undefined;
  if (details.dispatch_status === "possibly_sent" || details.action_sent === true) {
    return { action_sent: true, dispatch_status: "possibly_sent" };
  }
  return undefined;
}

function provenUnsent(error) {
  return error?.details && typeof error.details === "object" && error.details.action_sent === false;
}

function resolveExpectedPid(resolved, appRef, frame) {
  if (typeof resolved?.ownerPid === "number") return resolved.ownerPid;
  if (frame?.app?.pid !== null && typeof frame?.app?.pid === "number") return frame.app.pid;
  if (appRef && typeof appRef === "object" && typeof appRef.pid === "number") return appRef.pid;
  if (resolved?.app_ref && typeof resolved.app_ref.pid === "number") return resolved.app_ref.pid;
  return undefined;
}

export function createToolHandlers(deps) {
  const { callBroker, session, platform } = deps;

  const observe = async (args) => {
    const raw = await callBroker("capture_app", {
      app_ref: args.app_ref,
      include_screenshot: args.include_screenshot,
      force_full: args.disable_diffing,
      tree_shown_to_model: args.tree_shown_to_model,
    });
    const { state, screenshotBase64 } = await ingestCaptureAppResult(session, raw, {
      treeShownToModel: args.tree_shown_to_model,
    });
    const treeText = formatAppStateTree(state);
    const advisories = [
      effectEvidenceText(raw.effect_evidence),
      raw.screenshot_blank === true && args.include_screenshot ? "[screenshot_blank]" : "",
    ].filter(Boolean);
    const content = buildObservationContent(
      treeText,
      advisories,
      args.include_screenshot ? screenshotBase64 : undefined,
      args.include_screenshot ? state.image_ref : undefined,
    );
    return {
      content,
      structuredContent: {
        state_id: state.state_id,
        app: state.app,
        window: state.window,
        elements: state.elements,
        text: treeText,
        ...(state.has_image !== undefined ? { has_image: state.has_image } : {}),
        ...(state.image_size ? { image_size: state.image_size } : {}),
        ...(state.screenshot_blank ? { screenshot_blank: true } : {}),
        ...(state.image_ref ? { image_ref: state.image_ref } : {}),
        ...(state.non_actionable_reason
          ? { non_actionable_reason: state.non_actionable_reason }
          : {}),
        ...(state.snapshot_mode ? { snapshot_mode: state.snapshot_mode } : {}),
        ...(state.base_state_id ? { base_state_id: state.base_state_id } : {}),
      },
    };
  };

  /**
   * 动作收据装配:note + 收据字段;possibly_sent 保持非 error 结构(由 vendored SDK
   * assertOk 升级为 TIMEOUT+actionSent:true);return_state≠none 时追加动作后观察。
   */
  const postActionObserve = async ({ note, dispatch = {}, return_state = "none", appRef }) => {
    const structured = { ...dispatch };
    const content = [{ type: "text", text: note }];
    if (return_state === "compact" || return_state === "full") {
      try {
        const follow = await observe({
          app_ref: appRef,
          include_screenshot: false,
          disable_diffing: return_state === "full",
          tree_shown_to_model: true,
        });
        content.push(...follow.content);
        structured.state_id = follow.structuredContent.state_id;
        structured.snapshot_mode = follow.structuredContent.snapshot_mode;
        if (return_state === "full") structured.state = follow.structuredContent;
      } catch {
        // 动作已下发,补观察失败不能翻转收据语义。
      }
    }
    return { content, structuredContent: structured };
  };

  const bindTarget = async (target, options = {}) => {
    if (target.type === "element") {
      const resolved = resolveElementTarget(session, target, {
        appRef: options.appRef,
        allowRelocation: options.allowRelocation === true,
      });
      return { ...resolved, ownerPid: resolved.app_ref?.pid };
    }
    const { frame, point } = resolveCoordinateTarget(session, target);
    const frameAppRef = {
      ...(frame.app.pid !== null ? { pid: frame.app.pid } : {}),
      ...(frame.app.bundle_id ? { bundle_id: frame.app.bundle_id } : {}),
      ...(frame.window.window_id !== null ? { window_id: frame.window.window_id } : {}),
    };
    return {
      kind: "coordinate",
      isElement: false,
      point,
      app_ref: Object.keys(frameAppRef).length > 0 ? frameAppRef : undefined,
      frame,
      provenance: frameProvenanceFor(frame, target, point, options.endpointIndex ?? 0),
    };
  };

  return {
    async list_apps() {
      const result = await callBroker("list_applications", {});
      const apps = Array.isArray(result?.apps)
        ? result.apps
        : Array.isArray(result?.items)
          ? result.items
          : Array.isArray(result)
            ? result
            : [];
      return jsonResult({ apps }, { structuredContent: { apps } });
    },

    async list_windows(args) {
      const result = await callBroker("list_windows", { app_ref: args.app_ref });
      const windows = Array.isArray(result?.windows)
        ? result.windows
        : Array.isArray(result)
          ? result
          : [];
      return jsonResult(windows, { structuredContent: { windows } });
    },

    async get_app_state(args) {
      return await observe(args);
    },

    async left_click(args) {
      const button = args.mouse_button;
      const clicks = args.click_count;
      let target;
      try {
        target = await bindTarget(args.target, { appRef: args.app_ref, allowRelocation: true });
      } catch (error) {
        return toolErrorFromTarget(error);
      }
      const relocationNote = target.relocation
        ? `Note: element index ${target.relocation.requested_index} had shifted; acted on the ${target.relocation.seen} you saw there, now at index ${target.relocation.actual_index} (matched by ${target.relocation.match_criteria}, ${target.relocation.confidence} confidence). Re-observe before using indices from the older tree. `
        : "";
      const actionAppRef = args.app_ref ?? target.app_ref;
      const expectedPid = resolveExpectedPid(target, actionAppRef, target.frame);
      const semanticAxPress =
        target.isElement &&
        target.native &&
        button === "left" &&
        clicks === 1 &&
        !args.modifiers &&
        args.strategy !== "event";
      if (semanticAxPress) {
        try {
          const axResult = await callBroker(
            "element_perform_action",
            { native: target.native, action: "AXPress" },
            { kind: "action" },
          );
          return await postActionObserve({
            note:
              relocationNote +
              (axResult ? `${JSON.stringify(dispatchReceiptOf(axResult))} ` : "") +
              "Dispatched AXPress. (semantic AXPress on the element token; no coordinate hit-test.)",
            dispatch: dispatchReceiptOf(axResult),
            return_state: args.return_state,
            appRef: actionAppRef,
          });
        } catch (error) {
          const dispatch = dispatchReceiptFromError(error);
          if (dispatch) {
            return await postActionObserve({
              note: relocationNote + "AXPress may already have reached the target element.",
              dispatch,
              return_state: args.return_state,
              appRef: actionAppRef,
            });
          }
          if (error?.code !== "action_unavailable" || !provenUnsent(error)) {
            return toolErrorFromBroker(error);
          }
          // action_unavailable 且确证未下发:回落窗口定向事件点击(策略 a11y 除外)。
          if (args.strategy === "a11y") return toolErrorFromBroker(error);
        }
      }
      try {
        const result = await callBroker(
          "click",
          {
            point: target.point,
            button,
            clicks,
            modifiers: args.modifiers,
            strategy: target.isElement && (button === "left" || clicks > 1) ? "event" : args.strategy,
            expected_pid: expectedPid,
            app_ref: actionAppRef
              ? { ...actionAppRef, ...(expectedPid !== undefined ? { pid: expectedPid } : {}) }
              : undefined,
            ...(target.provenance ? { frame_provenance: [target.provenance] } : {}),
            ...(target.app_ref?.window_id !== undefined
              ? { expected_window_id: target.app_ref.window_id }
              : {}),
            ...(target.app_ref?.bundle_id ? { expected_bundle_id: target.app_ref.bundle_id } : {}),
          },
          { kind: "action" },
        );
        return await postActionObserve({
          note: relocationNote + JSON.stringify(dispatchReceiptOf(result)),
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: actionAppRef ?? target.app_ref,
        });
      } catch (error) {
        const dispatch = dispatchReceiptFromError(error);
        if (!dispatch) return toolErrorFromBroker(error);
        return await postActionObserve({
          note:
            relocationNote +
            (target.isElement
              ? "Element click may already have reached the target window."
              : "Coordinate click may already have reached the target window."),
          dispatch,
          return_state: args.return_state,
          appRef: actionAppRef ?? target.app_ref,
        });
      }
    },

    async scroll(args) {
      const requested = args.scroll_amount;
      const applied = Math.max(0, Math.min(100, requested));
      if (applied < 1) {
        return textResult(
          `Scrolled 0 (requested ${requested}, applied ${applied}; nothing to scroll). action_sent=false.`,
        );
      }
      if (args.strategy === "a11y") {
        return toolError(
          "scroll has no accessibility actuation; strategy=a11y requires an accessibility operation (AX/UIA/AT-SPI), but scrolling is implemented as raw pointer input. Use strategy=event (background/window-scoped on macOS) or keyboard navigation against a focused element.",
          { code: "action_unavailable", details: { action_sent: false } },
        );
      }
      let target;
      try {
        target = await bindTarget(args.target, { appRef: args.app_ref, allowRelocation: true });
      } catch (error) {
        return toolErrorFromTarget(error);
      }
      if (!target.point) {
        return toolError(
          "target did not resolve to a screen point; use a coordinate target with on-screen bounds.",
          { code: "element_unavailable", details: { action_sent: false } },
        );
      }
      const scopedAppRef = args.app_ref ?? target.app_ref;
      const expectedPid = resolveExpectedPid(target, scopedAppRef, target.frame);
      try {
        const result = await callBroker(
          "scroll",
          {
            point: target.point,
            direction: args.scroll_direction,
            amount: applied,
            ...(target.provenance ? { frame_provenance: [target.provenance] } : {}),
            ...(expectedPid !== undefined
              ? { app_ref: { ...scopedAppRef, pid: expectedPid } }
              : {}),
          },
          { kind: "action" },
        );
        return await postActionObserve({
          note: `Scrolled ${applied} (${args.scroll_direction}). ${JSON.stringify(dispatchReceiptOf(result))}`,
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: scopedAppRef,
        });
      } catch (error) {
        const dispatch = dispatchReceiptFromError(error);
        if (!dispatch) return toolErrorFromBroker(error);
        return await postActionObserve({
          note: "Scroll may already have reached the target window.",
          dispatch,
          return_state: args.return_state,
          appRef: scopedAppRef,
        });
      }
    },

    async left_click_drag(args) {
      let from;
      let to;
      try {
        from = await bindTarget(args.from_target, {
          appRef: args.app_ref,
          allowRelocation: true,
          endpointIndex: 0,
        });
        to = await bindTarget(args.to, {
          appRef: args.app_ref,
          allowRelocation: true,
          endpointIndex: 1,
        });
      } catch (error) {
        return toolErrorFromTarget(error);
      }
      if (!from.point || !to.point) {
        return toolError("drag endpoints must resolve to on-screen points.", {
          code: "element_unavailable",
          details: { action_sent: false },
        });
      }
      const startPid = resolveExpectedPid(from, from.app_ref, from.frame);
      const endPid = resolveExpectedPid(to, to.app_ref, to.frame);
      if (startPid !== undefined && endPid !== undefined && startPid !== endPid) {
        return toolError(
          "drag endpoints resolve to different applications; both endpoints must belong to the same live pid. action_sent=false.",
          { code: "invalid_request", details: { action_sent: false } },
        );
      }
      const expectedPid = args.app_ref?.pid ?? startPid ?? endPid;
      const scopedAppRef = args.app_ref ?? from.app_ref ?? to.app_ref;
      try {
        const result = await callBroker(
          "drag",
          {
            start: from.point,
            end: to.point,
            modifiers: args.modifiers,
            ...(from.provenance || to.provenance
              ? { frame_provenance: [from.provenance, to.provenance].filter(Boolean) }
              : {}),
            ...(expectedPid !== undefined
              ? { app_ref: { ...scopedAppRef, pid: expectedPid } }
              : {}),
          },
          { kind: "action" },
        );
        return await postActionObserve({
          note: `Dragged. ${JSON.stringify(dispatchReceiptOf(result))}`,
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: scopedAppRef,
        });
      } catch (error) {
        const dispatch = dispatchReceiptFromError(error);
        if (!dispatch) return toolErrorFromBroker(error);
        return await postActionObserve({
          note: "Drag may already have reached the target window.",
          dispatch,
          return_state: args.return_state,
          appRef: scopedAppRef,
        });
      }
    },

    async type(args) {
      if (args.text.length > 1024) {
        return toolError(
          "type text exceeds 1024 UTF-16 code units; split the input across calls.",
          { code: "invalid_request", details: { action_sent: false } },
        );
      }
      try {
        if (args.target) {
          // 坐标/元素目标先做 a11y hit-test 聚焦,再键入(观察优先语义,R8)。
          const target = await bindTarget(args.target, { appRef: args.app_ref, allowRelocation: true });
          if (target.native) {
            await callBroker("element_focus", { native: target.native }, { kind: "action" });
          }
        }
        const method = args.app_ref ? "type_text_to_app" : "type_text";
        const result = await callBroker(
          method,
          {
            text: args.text,
            ...(args.app_ref ? { app_ref: args.app_ref, strategy: args.strategy } : {}),
          },
          { kind: "action" },
        );
        return await postActionObserve({
          note: `Typed ${args.text.length} code units. ${JSON.stringify(dispatchReceiptOf(result))}`,
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: args.app_ref,
        });
      } catch (error) {
        return toolErrorFromAction(error, "Typing may already have reached the target app.", args);
      }
    },

    async set_value(args) {
      let target;
      try {
        target = await bindTarget(args.target, { appRef: args.app_ref, allowRelocation: true });
      } catch (error) {
        return toolErrorFromTarget(error);
      }
      if (!target.native) {
        return toolError(
          "set_value needs an accessibility element token; re-observe with get_app_state and pick a settable element.",
          { code: "not_settable", details: { action_sent: false } },
        );
      }
      try {
        const result = await callBroker(
          "element_set_value",
          { native: target.native, value: args.value, strategy: args.strategy },
          { kind: "action" },
        );
        return await postActionObserve({
          note: `Set value request dispatched. ${JSON.stringify(dispatchReceiptOf(result))}`,
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: args.app_ref ?? target.app_ref,
        });
      } catch (error) {
        return toolErrorFromAction(error, "Set value request may already have reached the app.", args);
      }
    },

    async select_text(args) {
      let target;
      try {
        target = await bindTarget(args.target, { appRef: args.app_ref, allowRelocation: true });
      } catch (error) {
        return toolErrorFromTarget(error);
      }
      if (!target.native) {
        return toolError(
          "select_text needs an accessibility element token; re-observe with get_app_state first.",
          { code: "not_selectable", details: { action_sent: false } },
        );
      }
      if (!args.text_range) {
        return toolError(
          "select_text requires text_range [start, length]; the SDK resolves it from the observed element value.",
          { code: "not_selectable", details: { action_sent: false } },
        );
      }
      try {
        const result = await callBroker(
          "element_select_text",
          { native: target.native, text_range: args.text_range },
          { kind: "action" },
        );
        return await postActionObserve({
          note: `Selection set. ${JSON.stringify(dispatchReceiptOf(result))}`,
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: args.app_ref ?? target.app_ref,
        });
      } catch (error) {
        return toolErrorFromAction(error, "Text-selection request may already have reached the app.", args);
      }
    },

    async key(args) {
      const repeat = args.repeat ?? 1;
      const holdSeconds = args.hold_seconds;
      try {
        if (holdSeconds !== undefined && holdSeconds !== null) {
          if (holdSeconds <= 0) {
            return toolError("hold_seconds must be positive to hold a key.", {
              code: "invalid_request",
              details: { action_sent: false },
            });
          }
          // [0,30] clamp 与负值拒绝语义逐字保留(30s 为 helper 硬上限)。
          const durationMs = Math.min(30_000, Math.round(holdSeconds * 1000));
          const method = args.app_ref ? "hold_key_to_app" : "hold_key";
          const result = await callBroker(
            method,
            {
              text: args.text,
              duration: durationMs,
              session_key: deps.sessionKey,
              ...(args.app_ref ? { app_ref: args.app_ref, strategy: args.strategy } : {}),
            },
            { kind: "action" },
          );
          return await postActionObserve({
            note: `Held ${args.text} for ${durationMs}ms. ${JSON.stringify(dispatchReceiptOf(result))}`,
            dispatch: dispatchReceiptOf(result),
            return_state: args.return_state,
            appRef: args.app_ref,
          });
        }
        const method = args.app_ref ? "press_key_to_app" : "press_key";
        let last;
        for (let index = 0; index < repeat; index += 1) {
          last = await callBroker(
            method,
            {
              text: args.text,
              ...(args.app_ref ? { app_ref: args.app_ref, strategy: args.strategy } : {}),
            },
            { kind: "action" },
          );
        }
        return await postActionObserve({
          note: `Pressed ${args.text}${repeat > 1 ? ` ×${repeat}` : ""}. ${JSON.stringify(dispatchReceiptOf(last))}`,
          dispatch: dispatchReceiptOf(last),
          return_state: args.return_state,
          appRef: args.app_ref,
        });
      } catch (error) {
        return toolErrorFromAction(
        error,
        args.hold_seconds
          ? "Key hold may already have reached the target app."
          : "Key press may already have reached the target app.",
        args,
      );
      }
    },

    async perform_action(args) {
      let target;
      try {
        target = await bindTarget(args.target, { appRef: args.app_ref, allowRelocation: true });
      } catch (error) {
        return toolErrorFromTarget(error);
      }
      if (!target.native) {
        return toolError(
          "perform_action needs an accessibility element token; re-observe with get_app_state first.",
          { code: "action_unavailable", details: { action_sent: false } },
        );
      }
      try {
        const result = await callBroker(
          "element_perform_action",
          { native: target.native, action: args.action },
          { kind: "action" },
        );
        return await postActionObserve({
          note: `Performed ${args.action}. ${JSON.stringify(dispatchReceiptOf(result))}`,
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: args.app_ref ?? target.app_ref,
        });
      } catch (error) {
        return toolErrorFromAction(error, `${args.action} may already have reached the element.`, args);
      }
    },

    async paste(args) {
      if (args.app_ref && !appRefHasIdentity(args.app_ref)) {
        return toolError(
          'paste was called with an app_ref that has no pid, bundle_id, or name, so it cannot be scoped to a target app. Call get_app_state first to bind a pid, then paste(text=..., app_ref={"pid":...}). action_sent=false.',
          { code: "invalid_request", details: { action_sent: false } },
        );
      }
      try {
        const result = await callBroker(
          "paste",
          { app_ref: args.app_ref, text: args.text, format: args.format },
          { kind: "action" },
        );
        return await postActionObserve({
          note:
            "Paste delivered: an app read the pasted text from the pasteboard. The paste shortcut cannot name a target field, so confirm the text landed in the field you meant. If it landed elsewhere, use set_value on a settable element instead.",
          dispatch: dispatchReceiptOf(result),
          return_state: args.return_state,
          appRef: args.app_ref,
        });
      } catch (error) {
        return toolErrorFromAction(error, "Paste may already have reached the target app.", args);
      }
    },

    /**
     * request_access:只读权限快照(R6)。broker_info 是连通性的权威证明;
     * side_effects 全 false 是隐私契约的可见面——这里绝不弹任何系统权限窗。
     */
    async request_access(args) {
      try {
        const brokerInfo = await callBroker("broker_info", {}, { kind: "read" });
        if (!brokerInfo || typeof brokerInfo !== "object" || Array.isArray(brokerInfo)) {
          throw new Error("request_access expected an object from broker_info");
        }
        const result =
          platform === "darwin"
            ? await callBroker("permission_status", {}, { kind: "read" })
            : await callBroker(
                "request_access",
                { capabilities: args.capabilities ?? [] },
                { kind: "read" },
              );
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new Error("request_access expected an object permission report from the Helper");
        }
        const guardPayload = {
          ...result,
          requested_capabilities: args.capabilities ?? [],
          broker: { ...brokerInfo, connected: true },
          side_effects: {
            permission_prompted: false,
            automation_warmup_attempted: false,
            screen_capture_attempted: false,
          },
          guard: deps.killSwitch.status(),
        };
        const base = jsonResult(guardPayload);
        // request-access 状态 meta(权限观察通道);形状不符(如 Windows 非 darwin schema)时
        // 不附 meta,权限事实以正文快照为准。
        const parsed = cuaRequestAccessStatusSchema.safeParse({
          schemaVersion: 1,
          platform: platform === "darwin" ? "darwin" : "darwin",
          grantOwner:
            typeof result.grant_owner === "string"
              ? result.grant_owner
              : typeof result.grantOwner === "string"
                ? result.grantOwner
                : "",
          accessibility: result.accessibility ?? "unknown",
          screenRecording: result.screenRecording ?? result.screen_recording ?? "unknown",
        });
        if (parsed.success) {
          return {
            ...base,
            _meta: { [CUA_REQUEST_ACCESS_STATUS_META_KEY]: parsed.data },
          };
        }
        return base;
      } catch (error) {
        return toolErrorFromBroker(error);
      }
    },

    /** stop:kill switch 闩锁幂等 + 释放按键保持/虚拟指针(R5)。 */
    async stop_computer_control(args) {
      const killSwitch = deps.killSwitch;
      killSwitch.stop(args.reason ?? null);
      try {
        await callBroker(
          "cancel_input_holds",
          { session_key: deps.sessionKey },
          { kind: "action", timeoutMs: 2000 },
        );
      } catch {
        // 释放失败不翻转停止语义;闩锁已落下,后续动作仍被拒。
      }
      const guardStatus = killSwitch.status();
      return jsonResult({
        stopped: true,
        // 重复 stop 幂等:报生效的闩锁原因,不声称被忽略的 reason 已生效。
        reason: guardStatus.stop_reason,
        guard: guardStatus,
      });
    },
  };

  function toolErrorFromTarget(error) {
    if (error instanceof TargetResolveError || error?.name === "TargetResolveError") {
      // 索引/帧解析失败一律归 element_unavailable 语义类(SDK → ELEMENT_UNAVAILABLE,reobserve)。
      return toolError(error.message, {
        code: "element_unavailable",
        details: { action_sent: false, reason: error.reason },
      });
    }
    return toolErrorFromBroker(error);
  }

  function toolErrorFromBroker(error) {
    // broker 不可用必须上抛到策略层(shouldPropagateToWrapper 同语义),由它归一
    // CUA_NOT_READY / broker_response_ambiguous 信封;handler 不吞。
    if (
      error instanceof Error &&
      error.name === "BrokerError" &&
      ["broker_unavailable", "stale_socket", "unavailable"].includes(error.code)
    ) {
      throw error;
    }
    if (error instanceof Error && error.name === "SchemaError") {
      return toolError(error.message, { code: "invalid_request", details: { action_sent: false } });
    }
    if (error instanceof Error && error.name === "TargetResolveError") {
      return toolError(error.message, {
        code: "element_unavailable",
        details: { action_sent: false, reason: error.reason },
      });
    }
    const code = typeof error?.code === "string" ? error.code : undefined;
    return toolError(error instanceof Error ? error.message : String(error), {
      ...(code ? { code } : {}),
      ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
    });
  }

  function toolErrorFromAction(error, ambiguousNote, args) {
    const dispatch = dispatchReceiptFromError(error);
    if (dispatch) {
      return postActionObserve({
        note: ambiguousNote,
        dispatch,
        return_state: args.return_state ?? "none",
        appRef: args.app_ref,
      });
    }
    return toolErrorFromBroker(error);
  }
}

function appRefHasIdentity(appRef) {
  return Boolean(
    appRef &&
      typeof appRef === "object" &&
      (typeof appRef.pid === "number" ||
        (typeof appRef.bundle_id === "string" && appRef.bundle_id) ||
        (typeof appRef.name === "string" && appRef.name)),
  );
}

/** 观察态引用(供 index.js 的 app-associations 摘取)。 */
export function stateAppOf(result, session) {
  const structured = result?.structuredContent;
  if (structured?.app && typeof structured.app === "object") return structured.app;
  const latest = session?.latestState?.();
  return latest ? latest.app : undefined;
}
