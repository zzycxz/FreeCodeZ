// ============================================================
// CUA 光标 HUD：覆盖窗页面模板（自 cuaCursorHud.ts 拆出——max-lines 400 门；语义零变化）
// ============================================================
// 纯静态 data:URL 页（无 nodeIntegration）：特效由 main 侧 executeJavaScript 调
// 页面全局函数驱动（__cuaDown/__cuaUp/__cuaTransform/__cuaReset/__cuaLoading）。

export function cursorWindowHtml(): string {
  // 纯静态页：位移由 setPosition 完成；动画/特效走 CSS 变换 + 全局函数。
  const svg = `<svg width="48" height="48" viewBox="0 0 48 48" style="position:absolute;left:36px;top:36px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M6 2 L6 40 L15 31 L21 45 L27 42 L21 29 L34 28 Z" fill="#1f2937" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none}
    #cursor{position:relative;width:120px;height:120px;will-change:transform;transition:transform .09s cubic-bezier(.2,.9,.3,1.2)}
    #cursor.down{transform:scale(.84)}
    #pulse{position:absolute;left:28px;top:28px;width:20px;height:20px;border-radius:50%;
      background:rgba(51,156,255,.55);opacity:0;transform:scale(.4)}
    #pulse.fire{animation:pulse .45s ease-out}
    @keyframes pulse{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(2.6)}}
    /* Phase 2 loading 透镜：48×48 圆环以光标热点（页内 40,40）为圆心，45 离散步进/圈
       （对齐 Codex 光标规格"45 帧透镜动画"的帧步进语义——自绘环替代官方 sprite 资产）。 */
    #lens{position:absolute;left:16px;top:16px;width:48px;height:48px;border-radius:50%;
      border:3px solid rgba(51,156,255,.85);border-top-color:rgba(255,255,255,.92);
      opacity:0;box-shadow:0 0 10px rgba(51,156,255,.35)}
    #lens.on{opacity:1;animation:lens-spin 1.8s steps(45) infinite}
    @keyframes lens-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  </style></head><body><div id="cursor">${svg}<div id="pulse"></div></div><div id="lens"></div>
  <script>
    window.__cuaDown = function () { document.getElementById("cursor").classList.add("down"); };
    window.__cuaUp = function () {
      var cursor = document.getElementById("cursor");
      cursor.classList.remove("down");
      var pulse = document.getElementById("pulse");
      pulse.classList.remove("fire"); void pulse.offsetWidth; pulse.classList.add("fire");
    };
    // Phase 2 第二步：scoot 变形（拉伸/旋转）+ 点击角度（-44°）——数值由 main 侧
    // scootTransform/clickTransform 算好传入，页面只做 CSS 应用。
    window.__cuaTransform = function (sx, sy, rotDeg) {
      var cursor = document.getElementById("cursor");
      cursor.style.transform = "scale(" + sx + "," + sy + ") rotate(" + rotDeg + "deg)";
    };
    window.__cuaReset = function () {
      var cursor = document.getElementById("cursor");
      cursor.style.transform = "";
    };
    // Phase 2 loading 透镜开关（main 侧按帧语义驱动：text 帧亮、移动帧灭）。
    window.__cuaLoading = function (on) {
      document.getElementById("lens").classList.toggle("on", !!on);
    };
  <\/script></body></html>`;
}

export function bannerWindowHtml(workArea: { width: number }): string {
  const width = Math.min(560, Math.max(360, Math.round(workArea * 0.5)));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    #banner{margin:10px auto;width:${width - 20}px;height:36px;border-radius:18px;
      background:linear-gradient(135deg,rgba(51,156,255,.95),rgba(28,120,220,.95));
      color:#fff;font:500 13px -apple-system,"SF Pro Text",system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;gap:8px;
      box-shadow:0 4px 16px rgba(15,80,160,.35);-webkit-font-smoothing:antialiased}
    .dot{width:8px;height:8px;border-radius:50%;background:#fff;animation:blink 1.2s infinite}
    @keyframes blink{0%,100%{opacity:.35}50%{opacity:1}}
  </style></head><body><div id="banner"><span class="dot"></span>FreeCodeZ 正在使用你的电脑 · 停止任务可取消</div></body></html>`;
}
