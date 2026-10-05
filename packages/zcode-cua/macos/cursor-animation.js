// ============================================================
// Phase 2 第二步（升级实施手册 桌面控制）：光标动画引擎
// ============================================================
// ChatGPT 光标行为规格（手册逆向提取，精确到数值）：
//   主弹簧 response = clamp(0.9 × 距离pt, 0.12s, 2.2s)；damping = 0.9（略过冲）
//   scoot 触发距离 >196pt；scoot response/damping = 0.24 / 0.84
//   scoot 拉伸：水平+38% 垂直-18%；scoot 旋转最大 76°；点击角度 -44°
//   路径：20 条候选贝塞尔弧（起柄 0.42 / 终柄 0.15 / 弧高 0.28 / 弧向 0.58）
//   直线阈值 <10pt；拉伸 pivot x=0.5
//   closeEnough ≤0.995pt 提前放行下一动作（流水线并行）；finished 等完全到位
// 纯函数积分器（无依赖、requestAnimationFrame 驱动、HUD 渲染层消费状态帧）。

/** 主弹簧参数（距离越远越慢的感知运动）。 */
export function primarySpringResponse(distancePt) {
  return clamp(0.9 * distancePt / 1000, 0.12, 2.2);
}

/** 主弹簧临界阻尼比（略有过冲）。 */
export const PRIMARY_SPRING_DAMPING = 0.9;
/** scoot（甩动）触发的最小距离（pt）。 */
export const SCOOT_THRESHOLD_PT = 196;
/** scoot 弹簧参数。 */
export const SCOOT_RESPONSE = 0.24;
export const SCOOT_DAMPING = 0.84;
/** scoot 拉伸变形（运动方向拉伸）。 */
export const SCOOT_STRETCH = { horizontal: 0.38, vertical: -0.18 };
/** scoot 最大旋转角（度）。 */
export const SCOOT_MAX_ROTATION_DEG = 76;
/** 点击时指针指向角（度）。 */
export const CLICK_ANGLE_DEG = -44;
/** 贝塞尔候选弧参数（起柄/终柄长度系数、弧高系数、弧向偏置）。 */
export const BEZIER_PARAMS = {
  startHandle: 0.42,
  endHandle: 0.15,
  arcHeight: 0.28,
  arcBias: 0.58,
  candidates: 20,
};
/** 直线阈值（pt）——极短距离不走弧。 */
export const STRAIGHT_LINE_THRESHOLD_PT = 10;
/** closeEnough：距目标 ≤0.995pt 即放行下一动作。 */
export const CLOSE_ENOUGH_PT = 0.995;
/** 拉伸 pivot（x=0.5 中心拉伸）。 */
export const STRETCH_PIVOT_X = 0.5;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 弹簧物理步进（半隐式欧拉；dt 秒）。返回新位置与速度。 */
export function springStep(position, velocity, target, response, damping, dt) {
  // 刚度/阻尼由 response/damping 推导（对齐 iOS SwiftUI spring 参数化）。
  const stiffness = Math.pow(2 * Math.PI / response, 2);
  const dampingCoefficient = 4 * Math.PI * damping / response;
  const force = (target - position) * stiffness - velocity * dampingCoefficient;
  const nextVelocity = velocity + force * dt;
  return { position: position + nextVelocity * dt, velocity: nextVelocity };
}

/** 单帧积分（双轴弹簧）。 */
export function cursorMotionStep(state, target, distanceHintPt, dt) {
  const response = distanceHintPt > SCOOT_THRESHOLD_PT ? SCOOT_RESPONSE : primarySpringResponse(distanceHintPt);
  const damping = distanceHintPt > SCOOT_THRESHOLD_PT ? SCOOT_DAMPING : PRIMARY_SPRING_DAMPING;
  const x = springStep(state.position.x, state.velocity.x, target.x, response, damping, dt);
  const y = springStep(state.position.y, state.velocity.y, target.y, response, damping, dt);
  return { position: { x: x.position, y: y.position }, velocity: { x: x.velocity, y: y.velocity } };
}

/** closeEnough 判定（连续操作提前放行）。 */
export function isCloseEnough(position, target) {
  const dx = position.x - target.x;
  const dy = position.y - target.y;
  return Math.sqrt(dx * dx + dy * dy) <= CLOSE_ENOUGH_PT;
}

/** 候选贝塞尔弧采样点（20 条候选按序；<10pt 直线）。 */
export function bezierPathCandidates(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < STRAIGHT_LINE_THRESHOLD_PT) {
    return [[from, to]];
  }
  const paths = [];
  for (let candidate = 0; candidate < BEZIER_PARAMS.candidates; candidate += 1) {
    // 弧向交替 + 弧高按候选序线性衰减（候选 0 最弯，19 最直）。
    const side = candidate % 2 === 0 ? 1 : -1;
    const heightScale = 1 - candidate / BEZIER_PARAMS.candidates;
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const normalX = -dy / distance;
    const normalY = dx / distance;
    const arcOffset = distance * BEZIER_PARAMS.arcHeight * heightScale * side * BEZIER_PARAMS.arcBias;
    // 三次贝塞尔控制点（起柄/终柄系数）。
    const p1 = {
      x: from.x + dx * BEZIER_PARAMS.startHandle + normalX * arcOffset,
      y: from.y + dy * BEZIER_PARAMS.startHandle + normalY * arcOffset,
    };
    const p2 = {
      x: from.x + dx * (1 - BEZIER_PARAMS.endHandle) + normalX * arcOffset,
      y: from.y + dy * (1 - BEZIER_PARAMS.endHandle) + normalY * arcOffset,
    };
    // 采样 24 点。
    const samples = [];
    for (let step = 0; step <= 24; step += 1) {
      const t = step / 24;
      const u = 1 - t;
      samples.push({
        x: u * u * u * from.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * to.x,
        y: u * u * u * from.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * to.y,
      });
    }
    paths.push(samples);
  }
  return paths;
}

/** 运动方向角（度）与 scoot 变换（拉伸/旋转）。 */
export function scootTransform(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance < SCOOT_THRESHOLD_PT) {
    return { rotationDeg: 0, scaleX: 1, scaleY: 1 };
  }
  const angle = Math.atan2(dy, dx);
  const rotationDeg = clamp((angle * 180) / Math.PI, -SCOOT_MAX_ROTATION_DEG, SCOOT_MAX_ROTATION_DEG);
  return {
    rotationDeg,
    scaleX: 1 + SCOOT_STRETCH.horizontal,
    scaleY: 1 + SCOOT_STRETCH.vertical,
  };
}

/** 点击视觉角（指针指向 -44°）。 */
export function clickTransform() {
  return { rotationDeg: CLICK_ANGLE_DEG };
}
