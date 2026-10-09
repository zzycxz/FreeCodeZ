/**
 * 草稿态空态问候：时间问候语 + quartet 品牌水印（四人方结图标，替换原 ZCode Z）。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * 手机远控复用同一组件，但继续保留 20px 紧凑标题；桌面草稿首页才按标题自身宽度适配。
 */
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import darkEmptyStateLogoUrl from "@/assets/quartet-empty-dark.svg";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;
const GREETING_MIN_FONT_SIZE_PX = 20;
const GREETING_MAX_FONT_SIZE_PX = 30;

type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

function getChatEmptyGreetingMessageId(date: Date = new Date()): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ?? tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

function resolveGreetingFontSizePx({
  availableWidthPx,
  naturalTextWidthPx,
}: {
  availableWidthPx: number;
  naturalTextWidthPx: number;
}) {
  if (
    !Number.isFinite(availableWidthPx) ||
    !Number.isFinite(naturalTextWidthPx) ||
    availableWidthPx <= 0 ||
    naturalTextWidthPx <= 0 ||
    availableWidthPx >= naturalTextWidthPx
  ) {
    return GREETING_MAX_FONT_SIZE_PX;
  }

  return Math.max(
    GREETING_MIN_FONT_SIZE_PX,
    Math.min(
      GREETING_MAX_FONT_SIZE_PX,
      Math.floor(GREETING_MAX_FONT_SIZE_PX * (availableWidthPx / naturalTextWidthPx)),
    ),
  );
}

export function ConversationDraftEmptyState({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const [greetingFontSizePx, setGreetingFontSizePx] = useState(GREETING_MAX_FONT_SIZE_PX);
  const greetingContainerRef = useRef<HTMLParagraphElement | null>(null);
  const greetingMeasurementRef = useRef<HTMLSpanElement | null>(null);
  const greeting = intl.formatMessage({
    id: isOfficeMode ? "chat.empty.greeting.office" : getChatEmptyGreetingMessageId(greetingDate),
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [greetingDate]);

  useLayoutEffect(() => {
    const container = greetingContainerRef.current;
    const measurement = greetingMeasurementRef.current;
    if (!container || !measurement) {
      return;
    }

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const containerStyle = window.getComputedStyle(container);
      const horizontalPaddingPx =
        Number.parseFloat(containerStyle.paddingLeft) +
        Number.parseFloat(containerStyle.paddingRight);
      const availableWidthPx = Math.max(
        0,
        container.getBoundingClientRect().width - horizontalPaddingPx,
      );
      const naturalTextWidthPx = measurement.getBoundingClientRect().width;
      const nextFontSizePx = resolveGreetingFontSizePx({
        availableWidthPx,
        naturalTextWidthPx,
      });

      setGreetingFontSizePx((currentFontSizePx) => {
        if (currentFontSizePx === nextFontSizePx) {
          return currentFontSizePx;
        }
        logger.debug("[v4-draft-greeting] 标题自身可用宽度变化，更新字号", {
          availableWidthPx: Math.round(availableWidthPx),
          naturalTextWidthPx: Math.round(naturalTextWidthPx),
          previousFontSizePx: currentFontSizePx,
          nextFontSizePx,
        });
        return nextFontSizePx;
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        return;
      }
      frameId = window.requestAnimationFrame(measure);
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", scheduleMeasure);
      return () => {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        window.removeEventListener("resize", scheduleMeasure);
      };
    }

    // 标题字号曾直接绑定整个视口宽度，最小窗口里文字两侧仍有大量空间却被
    // 强制缩到 20px。分别观察标题容器和 30px 原始文案，只在两者真实相撞时缩小。
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    observer.observe(measurement);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [greeting]);

  return (
    <div
      className={cn(
        "relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 aspect-[5/4] w-[min(72vw,25rem)] -mt-10",
          "-translate-x-1/2 -translate-y-1/2 text-foreground-subtlest",
        )}
      >
        <EmptyStateBrandMark className="h-full w-full" />
      </div>
      <p
        ref={greetingContainerRef}
        data-v4-draft-greeting="true"
        style={
          {
            "--v4-draft-greeting-font-size": `${greetingFontSizePx}px`,
          } as CSSProperties
        }
        className={cn(
          "relative z-10 w-full px-4 text-center font-medium text-foreground",
          "text-[length:var(--v4-draft-greeting-font-size)]/[1.2]",
        )}
      >
        <span
          ref={greetingMeasurementRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute whitespace-nowrap text-3xl/[1.2]"
        >
          {greeting}
        </span>
        <span>{greeting}</span>
      </p>
    </div>
  );
}

function EmptyStateBrandMark({ className }: { className?: string }) {
  return (
    <>
      {/* 深色资源已自带渐变和透明度，公共容器叠加遮罩会让它重复变淡；渐隐效果只属于浅色线框。*/}
      <svg
        aria-hidden="true"
        className={cn(
          className,
          "opacity-70 dark:hidden",
          "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
          "[mask-image:linear-gradient(to_bottom,black_0%,transparent_70%,transparent_100%)]",
          "[mask-repeat:no-repeat] [mask-size:100%_100%]",
        )}
        width="400"
        height="320"
        viewBox="0 0 400 320"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M 298.26 4.8 L 305.88 5.36 L 314.05 7.4 L 321.3 10.93 L 327.61 15.58 L 332.26 20.41 L 337.27 28.21 L 340.43 36.38 L 341.73 44.37 L 341.54 52.73 L 339.87 60.71 L 336.16 69.07 L 331.51 75.58 L 324.83 81.89 L 317.4 86.35 L 309.59 89.14 L 300.68 90.44 L 291.95 89.88 L 282.84 87.28 L 274.86 83.01 L 270.21 79.29 L 264.45 72.97 L 260 65.36 L 257.4 57.74 L 256.28 50.31 L 256.47 42.51 L 258.7 33.22 L 262.04 25.98 L 267.8 18.18 L 274.3 12.6 L 281.92 8.33 L 289.9 5.73 Z M 97.27 4.99 L 103.96 4.99 L 112.51 6.47 L 121.61 10.37 L 127.92 14.83 L 134.98 22.63 L 138.88 29.51 L 141.85 38.98 L 142.6 45.11 L 141.85 55.33 L 139.44 63.5 L 136.1 70 L 131.82 75.76 L 125.88 81.33 L 120.49 84.86 L 112.69 88.21 L 103.77 90.06 L 95.79 90.06 L 88.91 88.76 L 80 85.23 L 73.87 81.15 L 67.74 75.2 L 63.84 69.63 L 59.56 59.6 L 58.26 52.54 L 58.26 43.25 L 59.56 36.19 L 63.28 27.09 L 68.11 20.03 L 74.24 14.09 L 80 10.19 L 88.17 6.66 Z M 246.06 28.21 L 250.71 28.76 L 247.74 37.5 L 246.44 45.67 L 246.62 55.51 L 248.67 65.17 L 250.52 70.19 L 254.24 76.88 L 259.07 83.19 L 264.27 88.39 L 269.84 92.48 L 277.83 96.75 L 286.93 99.72 L 295.85 100.84 L 305.14 100.47 L 311.27 99.17 L 319.25 96.19 L 327.24 91.74 L 330.58 100.65 L 332.07 109.38 L 331.88 119.04 L 329.66 130.19 L 326.87 137.62 L 320.74 148.58 L 313.31 157.68 L 304.39 166.6 L 275.41 192.79 L 260.74 204.86 L 254.05 208.58 L 248.11 210.25 L 240.12 210.81 L 233.06 209.51 L 227.67 207.28 L 222.66 203.93 L 216.53 196.87 L 213.56 191.49 L 215.41 184.61 L 221.54 175.51 L 236.78 160.09 L 253.87 144.12 L 248.48 145.05 L 242.16 145.05 L 237.52 144.31 L 228.42 141.33 L 220.62 137.25 L 209.84 128.52 L 181.05 98.61 L 180.12 98.79 L 163.4 115.51 L 150.59 126.66 L 126.44 144.86 L 109.9 155.45 L 99.32 163.44 L 94.67 161.21 L 88.91 156.75 L 83.53 151.36 L 79.44 146.16 L 75.91 140.4 L 72.57 132.79 L 70.71 126.29 L 69.22 117.18 L 69.22 104.92 L 71.82 91.92 L 72.75 91.55 L 80.37 96.19 L 89.1 99.35 L 94.86 100.47 L 104.33 100.84 L 111.39 99.91 L 118.82 97.68 L 124.77 95.08 L 132.94 89.88 L 138.7 84.68 L 144.83 77.43 L 149.1 70 L 152.26 61.46 L 153.74 53.28 L 153.93 44.93 L 152.44 36.01 L 150.4 29.51 L 150.77 28.76 L 162.85 29.32 L 172.13 31.74 L 182.91 36.38 L 192.94 42.88 L 208.91 57.93 L 271.7 122.57 L 272.81 122.94 L 274.49 118.86 L 205.2 46.78 L 205.2 46.04 L 212.63 39.35 L 222.47 33.59 L 233.25 29.88 Z M 142.78 146.91 L 150.4 146.91 L 159.13 148.58 L 166 151.74 L 172.5 156.38 L 185.14 168.83 L 226.37 213.96 L 238.26 224.92 L 246.25 223.25 L 253.49 218.24 L 307.55 169.2 L 313.31 174.58 L 318.32 180.9 L 323.53 190.37 L 325.01 194.46 L 327.05 202.82 L 327.98 211.18 L 327.61 220.28 L 326.13 228.27 L 325.2 228.45 L 322.22 226.04 L 314.24 221.95 L 306.81 219.72 L 299.19 218.61 L 291.2 218.79 L 281.36 220.84 L 274.67 223.62 L 266.87 228.27 L 260 233.84 L 257.02 237.37 L 254.05 241.46 L 249.78 249.44 L 246.99 258.55 L 246.06 268.21 L 246.99 278.42 L 249.41 286.04 L 247.55 286.41 L 243.09 285.85 L 233.25 283.25 L 226 280.09 L 217.64 275.08 L 212.44 270.99 L 200.93 259.29 L 143.16 196.5 L 141.48 195.57 L 139.25 198.17 L 139.25 199.1 L 162.66 223.62 L 197.4 262.26 L 193.68 267.46 L 188.11 273.03 L 178.08 279.91 L 167.86 284.18 L 158.76 286.22 L 150.77 286.78 L 150.59 285.48 L 153.93 271.73 L 153.37 259.66 L 152.26 254.46 L 149.1 246.1 L 144.64 238.67 L 140.93 234.03 L 131.82 226.6 L 125.51 223.25 L 116.59 220.09 L 108.05 218.61 L 99.5 218.79 L 88.91 221.21 L 81.67 224.37 L 74.61 229.2 L 73.31 229.38 L 71.82 219.72 L 72.38 208.76 L 75.17 197.62 L 80.37 187.22 L 87.43 178.3 L 98.76 168.64 L 123.28 152.48 L 132.01 148.58 Z M 296.03 228.45 L 304.02 228.82 L 312.57 231.05 L 321.11 235.33 L 327.24 239.97 L 332.81 246.1 L 337.27 253.53 L 339.87 260.22 L 341.36 268.58 L 341.36 275.45 L 340.06 283.07 L 336.34 292.17 L 331.14 299.6 L 324.08 306.29 L 316.09 311.12 L 308.85 313.72 L 299.38 315.02 L 290.65 314.46 L 283.4 312.42 L 278.39 310.19 L 269.84 304.06 L 264.64 298.48 L 260 290.68 L 256.84 281.95 L 255.54 273.41 L 255.91 264.12 L 257.77 256.69 L 260.55 250.37 L 265.75 242.94 L 273.37 236.07 L 280.43 232.17 L 289.35 229.38 Z M 98.57 228.64 L 106.38 228.64 L 115.48 230.5 L 123.84 234.21 L 129.97 238.48 L 134.98 243.5 L 139.25 249.82 L 142.6 257.8 L 144.08 266.16 L 143.9 275.45 L 142.23 284.92 L 138.88 292.73 L 134.42 299.23 L 127.37 306.1 L 121.61 309.81 L 111.76 313.72 L 103.4 315.02 L 94.86 314.64 L 87.61 312.97 L 80.18 310 L 74.43 306.29 L 67.37 299.23 L 62.54 291.8 L 59.56 284.74 L 58.08 276.01 L 58.26 268.02 L 59.75 260.4 L 63.28 251.67 L 68.11 244.43 L 74.61 238.3 L 82.41 233.28 L 89.29 230.5 Z"
          stroke="currentColor"
          strokeWidth="0.8"
          strokeLinejoin="miter"
          strokeMiterlimit="10"
          fillRule="evenodd"
        />
      </svg>
      {/* 深色资源包含专用渐变与模糊效果，不能通过 currentColor 复刻；主题类保证两套 Logo 互斥显示。 */}
      <img
        aria-hidden="true"
        className={cn(className, "hidden dark:block")}
        data-v4-draft-logo="dark"
        src={darkEmptyStateLogoUrl}
        alt=""
      />
    </>
  );
}
