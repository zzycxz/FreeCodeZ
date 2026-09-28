import { useLayoutEffect, useRef } from "react";

/** 仅拥有 DOM 布局投影；权限、Plan 和 CUA 业务状态仍由原有 hooks 管理。 */
function fitComposerToolbar(root: HTMLElement) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  // 优先级只声明收纳次序，逐轮（0→3）整批收纳；不再逐个排序插队。
  const controls = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
  // 每次从完整布局测量，避免各按钮独立 observer 互相抢空间，也覆盖语言与异步入口变化。
  delete root.dataset.composerModelIcon;
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
  // 溢出量同时考虑主行与尾部行动作区；只比主行会漏掉「加上发送键就超宽」的情形。
  const overflow = () =>
    Math.max(
      0,
      content.getBoundingClientRect().width - available.getBoundingClientRect().width,
      trailing
        ? content.getBoundingClientRect().width +
            trailing.getBoundingClientRect().width +
            gap -
            root.getBoundingClientRect().width
        : 0,
    );
  for (const priority of ["0", "1", "2", "3"]) {
    if (overflow() <= 0) return;
    for (const control of controls) {
      if (control.dataset.composerCollapsePriority === priority) {
        control.dataset.composerCompact = "true";
      }
    }
  }
  if (overflow() <= 0) return;
  // 提供方前缀收成紧凑态（存在即收，不再按行宽二次判定）。
  if (root.querySelector(".composer-provider-prefix")) {
    root.dataset.composerProviderCompact = "true";
  }
  if (overflow() <= 0) return;
  // 思考档位控件的图标态：文字收起、留图标+进度，不再整个消失（上游 3.14.1 修复）。
  const thought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
  if (thought) thought.dataset.composerCompact = "icon";
  if (!(overflow() <= 0)) root.dataset.composerModelIcon = "true";
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // 在不可见副本上尝试展开，避免真实按钮测量时来回移动、丢失 hover 或关闭 Tooltip。
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${root.getBoundingClientRect().width}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        for (const key of ["composerModelIcon", "composerProviderCompact"]) {
          if (probe.dataset[key]) root.dataset[key] = probe.dataset[key];
          else delete root.dataset[key];
        }
        const live = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        const measured = probe.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        live.forEach((control, index) => {
          // 按量测值原样回写（"true" 或 "icon"）；强制置 "true" 会把图标态顶掉，
          // 文字消失后没有兜底（上游 3.14.1 修复）。
          const measuredCompact = measured[index]?.dataset.composerCompact;
          if (measuredCompact) control.dataset.composerCompact = measuredCompact;
          else delete control.dataset.composerCompact;
        });
      } finally {
        probe.remove();
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      update();
    };
    // 不观察布局属性自身，防止写 data-composer-compact 引起递归测量。
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
    };
  }, []);
  return ref;
}
