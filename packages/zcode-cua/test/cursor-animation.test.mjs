// Phase 2 第二步（升级实施手册）：光标动画引擎测试——30 参数规格逐项钉死。
import assert from "node:assert/strict";
import test from "node:test";
import {
  primarySpringResponse,
  PRIMARY_SPRING_DAMPING,
  SCOOT_THRESHOLD_PT,
  SCOOT_RESPONSE,
  SCOOT_DAMPING,
  BEZIER_PARAMS,
  STRAIGHT_LINE_THRESHOLD_PT,
  CLOSE_ENOUGH_PT,
  clamp,
  springStep,
  cursorMotionStep,
  isCloseEnough,
  bezierPathCandidates,
  scootTransform,
  clickTransform,
} from "../macos/cursor-animation.js";

test("主弹簧 response = clamp(0.9×距离/1000, 0.12, 2.2)", () => {
  assert.equal(primarySpringResponse(20), 0.12, "下限钳制");
  assert.equal(primarySpringResponse(50), 0.12, "0.9×50/1000=0.045 → 0.12");
  assert.ok(Math.abs(primarySpringResponse(1000) - 0.9) < 1e-9, "1000pt → 0.9");
  assert.equal(primarySpringResponse(5000), 2.2, "上限钳制");
  assert.equal(PRIMARY_SPRING_DAMPING, 0.9);
});

test("scoot 阈值与参数：>196pt 进甩动模式", () => {
  assert.equal(SCOOT_THRESHOLD_PT, 196);
  assert.equal(SCOOT_RESPONSE, 0.24);
  assert.equal(SCOOT_DAMPING, 0.84);
  const far = scootTransform({ x: 0, y: 0 }, { x: 400, y: 0 });
  assert.ok(Math.abs(far.scaleX - 1.38) < 1e-9, "水平+38%（浮点容差）");
  assert.ok(Math.abs(far.scaleY - 0.82) < 1e-9, "垂直-18%（浮点容差）");
  assert.ok(Math.abs(far.rotationDeg) <= 76, "旋转 ≤76°");
  const near = scootTransform({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(near, { rotationDeg: 0, scaleX: 1, scaleY: 1 }, "近距不变形");
});

test("点击角 -44°；贝塞尔 20 候选起终柄/弧参数", () => {
  assert.deepEqual(clickTransform(), { rotationDeg: -44 });
  assert.equal(BEZIER_PARAMS.startHandle, 0.42);
  assert.equal(BEZIER_PARAMS.endHandle, 0.15);
  assert.equal(BEZIER_PARAMS.arcHeight, 0.28);
  assert.equal(BEZIER_PARAMS.candidates, 20);
});

test("贝塞尔：20 候选×25 采样点；<10pt 直线；端点闭合", () => {
  const paths = bezierPathCandidates({ x: 0, y: 0 }, { x: 300, y: 200 });
  assert.equal(paths.length, 20);
  for (const path of paths) {
    assert.equal(path.length, 25);
    assert.deepEqual(path[0], { x: 0, y: 0 }, "起点=from");
    assert.ok(Math.abs(path[24].x - 300) < 1e-6 && Math.abs(path[24].y - 200) < 1e-6, "终点=to");
  }
  const straight = bezierPathCandidates({ x: 0, y: 0 }, { x: 5, y: 3 });
  assert.equal(straight.length, 1, "直线阈值内单路径");
  assert.equal(STRAIGHT_LINE_THRESHOLD_PT, 10);
  // 弯候选首点偏离直线（弧存在性）
  const direct = bezierPathCandidates({ x: 0, y: 0 }, { x: 300, y: 0 })[0];
  const midY = direct[12]?.y ?? 0;
  assert.ok(Math.abs(midY) > 1, `候选 0 中点应有弧高偏移（实际 y=${midY}）`);
});

test("closeEnough ≤0.995pt 提前放行", () => {
  assert.equal(CLOSE_ENOUGH_PT, 0.995);
  assert.equal(isCloseEnough({ x: 100, y: 100 }, { x: 100.5, y: 100 }), true);
  assert.equal(isCloseEnough({ x: 100, y: 100 }, { x: 102, y: 100 }), false);
});

test("弹簧积分：4 秒 60fps 收敛到目标（远距 scoot 参数）", () => {
  let state = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
  const target = { x: 500, y: 300 };
  const distance = Math.hypot(500, 300);
  for (let frame = 0; frame < 240; frame += 1) {
    state = cursorMotionStep(state, target, distance, 1 / 60);
  }
  assert.ok(Math.abs(state.position.x - 500) < 0.5, `x 收敛（${state.position.x}）`);
  assert.ok(Math.abs(state.position.y - 300) < 0.5, `y 收敛（${state.position.y}）`);
  assert.equal(isCloseEnough(state.position, target), true);
});

test("弹簧单步：向目标移动且不发散", () => {
  const step = springStep(0, 0, 100, 0.24, 0.84, 1 / 60);
  assert.ok(step.position > 0 && step.position < 100, "首步在 (0,100) 区间");
  assert.ok(step.velocity > 0);
  // 大 dt 不发散（半隐式欧拉的稳定性边界由 response 推导的刚度保证）
  const big = springStep(0, 0, 100, 0.24, 0.84, 0.5);
  assert.ok(Number.isFinite(big.position));
});

test("clamp 契约", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test("用户干预：鼠标活跃判定+状态机 idle↔paused", async () => {
  const { readUserMouseActivity, nextInterventionState, USER_MOUSE_ACTIVITY_THRESHOLD_MS } = await import("../macos/cursor-animation.js");
  assert.equal(USER_MOUSE_ACTIVITY_THRESHOLD_MS, 800);
  // 状态机：用户动→paused；静默+resume→idle；静默无 resume→保持 paused
  assert.equal(nextInterventionState("idle", true, false), "paused");
  assert.equal(nextInterventionState("paused", true, false), "paused");
  assert.equal(nextInterventionState("paused", false, true), "idle");
  assert.equal(nextInterventionState("paused", false, false), "paused");
  assert.equal(nextInterventionState("idle", false, false), "idle");
  // 真机检测（不崩、返回结构化）
  const activity = readUserMouseActivity(undefined);
  assert.equal(activity.userActive, false, "无 bindings 恒不活跃");
});
