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
          d="M 270.34 16.14 L 264.92 22.46 C 258.18 31.65 255.67 43.53 257.5 54.43 Q 260.31 71.2 272.79 81.12 Q 281.65 88.17 293.33 89.63 Q 304.42 91.01 315.58 86.99 L 321.28 83.87 C 342.91 71.41 348.49 43.32 334.68 23.02 Q 326.53 11.05 312.54 6.41 Q 304.23 3.65 294.62 4.8 Q 280.42 6.5 270.34 16.14 Z M 82.11 8.74 A 42.71 41.99 -68.5 0 0 73.93 13.86 A 42.61 42.11 -59.8 0 0 64.03 25.04 A 42.73 42.12 -59.9 0 0 58.04 41.67 A 42.76 42.16 -66 0 0 67.17 74.59 A 42.78 42.15 -70.1 0 0 81.19 85.7 A 42.74 42.18 -73.3 0 0 92.69 89.37 A 42.8 42.05 -59.5 0 0 103.56 89.72 A 42.74 42.18 -66.2 0 0 124.26 81.88 A 43.44 42.45 -73.8 0 0 128.95 77.96 A 42.7 42.13 -66.3 0 0 138.31 64.7 A 43.44 42.81 -79 0 0 140.53 58.67 A 42.76 42.19 -66.3 0 0 131.96 19.13 A 42.71 42.15 -64 0 0 111.26 6.06 A 42.72 42.16 -66.8 0 0 82.11 8.74 Z M 211.52 40.19 Q 208.56 42.33 206.09 45.11 Q 204.98 46.36 206.17 47.52 Q 217.18 58.24 227.57 69.55 Q 228.56 70.62 238.91 81.4 Q 244.55 87.29 250.05 93.43 L 261.02 105.12 L 270.23 115.15 Q 268.09 114 266.33 112.14 Q 261.57 107.08 256.39 101.52 A 0.61 0.6 49.6 0 0 255.57 101.45 L 255.54 101.47 A 0.52 0.52 0 0 0 255.5 102.21 L 259.6 106.73 A 0.1 0.1 0 0 1 259.6 106.86 L 259.45 107.01 A 0.13 0.13 0 0 1 259.27 107.01 L 255.22 103.26 A 0.06 0.05 42.6 0 0 255.14 103.26 L 255 103.39 A 0.24 0.24 0 0 0 255 103.72 Q 257.19 106.01 259.44 108.26 Q 266.39 115.26 269.43 118.71 Q 269.69 119.02 269.18 119.16 Q 268.76 118.49 267.95 117.88 L 256.25 106.33 C 248.05 98.01 238.82 89.13 231.52 81.43 C 223.84 73.32 217.67 67.59 210.33 59.6 C 203.65 52.34 196.52 45.32 188.28 39.5 Q 177.7 32.71 165.18 29.69 Q 158.04 28.15 150.61 28.6 A 0.25 0.25 0 0 0 150.37 28.93 Q 152.31 35.21 153.58 42.65 C 154.96 50.73 152.71 60.98 149.7 68.36 Q 148.32 71.76 143.31 79.35 Q 140.61 82.52 137.15 85.87 Q 127.69 95.07 114.67 98.96 Q 103.39 102.25 93.54 100.45 Q 81.99 98.33 72.19 91.73 A 0.47 0.47 0 0 0 71.47 91.98 C 68.77 100.89 68.28 108.35 69.07 117.96 C 69.41 122.1 70.59 126.42 71.5 130.68 Q 72.83 135.59 74.85 138.86 Q 75.76 140.34 76.04 141.03 A 1.07 0.07 69.5 0 0 76.34 141.7 L 79.31 146.49 A 4.4 0.31 45.4 0 0 81.2 148.7 Q 81.3 148.79 82.05 149.78 Q 88.31 157.98 98.1 163.42 A 0.36 0.35 41.8 0 0 98.46 163.4 L 125.72 145.07 L 139 134.99 L 152.64 124.48 C 162.47 116.48 171.47 107.26 180.4 98.26 Q 180.4 97.96 180.82 98.4 Q 196.39 114.64 212.35 130.49 Q 214.37 132.5 218.91 135.7 Q 223.23 138.85 229.78 141.6 Q 240.43 146.08 251.11 144.56 L 254.84 143.43 Q 254.85 143.88 254.09 144.49 L 226.52 171.32 L 222.17 175.94 Q 217.9 180.74 215.86 184.53 Q 214.9 186.31 213.85 190.76 A 1.66 1.66 0 0 0 213.85 191.55 Q 214.32 193.45 215 194.5 Q 217.77 198.75 221.53 202.83 C 224.78 206.35 228.69 208 233.07 209.67 C 237.91 211.52 243.85 211.34 248.9 210.42 L 255.5 207.91 C 261.15 205.53 265.8 201.21 270.24 197.06 L 285.87 183.6 C 301.36 169.03 318.37 156.92 327.1 137.76 C 333.62 123.44 334.74 106.28 327.71 91.93 A 0.34 0.32 -30.4 0 0 327.22 91.81 Q 317.04 98.99 304.91 100.59 Q 290.49 102.3 277.44 96.38 L 272.76 93.9 Q 267.44 91.07 262.82 86.56 Q 254.99 79.2 250.51 69.63 Q 249.61 67.8 249.02 65.86 Q 243.18 46.9 250.78 28.62 A 0.33 0.33 0 0 0 250.49 28.16 Q 228.83 27.29 211.52 40.19 Z M 91.11 175.04 Q 84.32 180.67 79.84 188.21 Q 68.45 207.35 72.63 229.56 A 0.43 0.43 0 0 0 73.31 229.83 Q 75.26 228.39 77.41 227.02 Q 95.84 215.23 117.24 220.76 Q 124.63 222.67 132.67 228.02 Q 145.05 236.49 150.68 250.43 C 153.63 258.86 154.92 268.54 152.94 277.28 C 151.9 281.86 151.41 284.6 150.26 286.87 A 0.33 0.33 0 0 0 150.55 287.34 C 169 287.24 186.31 278.32 197.15 263.45 A 0.62 0.62 0 0 0 197.11 262.66 L 163.89 226.13 L 143.91 203.85 Q 144.2 203.55 144.41 203.85 L 159.06 218.75 A 0.27 0.27 0 0 0 159.51 218.64 Q 159.9 217.27 159.17 216.14 Q 157.69 213.84 155.54 211.55 Q 150.84 206.51 146.44 201.21 L 153.8 208.97 L 172.06 228.12 L 194.89 252.86 A 1.22 0.63 81 0 1 195.01 253.03 Q 195.93 254.52 197.1 255.31 A 2.07 2.04 87.3 0 1 197.57 255.74 Q 199.47 258.21 201.09 259.8 Q 203.12 261.78 204.57 263.48 C 210.07 269.88 217.17 276.2 224.84 279.94 Q 236.15 286.15 249.02 286.96 A 0.28 0.28 0 0 0 249.3 286.59 Q 244.61 273.29 247.28 259.36 C 248.83 249.59 254.19 240.61 261.24 233.54 Q 268.24 227.19 276.72 223.16 Q 292.85 216.05 309.5 220.65 Q 318.81 223.31 326.3 229.01 A 0.11 0.1 24.9 0 0 326.48 228.95 C 331.74 206.99 325.78 184.78 308.28 169.82 A 0.45 0.45 0 0 0 307.69 169.82 L 295.86 180.81 L 272.57 202.06 L 262.49 211.04 Q 257.93 215.19 253.34 219.22 Q 247.2 224.59 239.47 225.57 Q 237.7 225.22 236.65 224.27 Q 228.58 216.94 220.31 207.96 Q 203.19 189.38 186.35 170.75 L 179.08 163.61 Q 176.75 161.07 174.22 158.57 Q 162.09 146.56 145.03 147.16 C 137.15 147.43 130.83 148.52 124.12 152.32 Q 111.02 159.74 96.71 170.41 Q 93.08 173.12 91.11 175.04 Z M 290.24 230.04 Q 273.88 233.23 264.15 246.48 C 258.54 253.71 255.7 263.16 255.89 272.26 Q 255.97 276.58 257.75 284.05 C 258.83 288.66 261.53 293.8 263.81 297.28 C 269.81 306.44 280.18 312.8 290.72 314.9 Q 298.74 316.5 308.58 314.43 Q 328.19 309 337.39 291.35 Q 341.91 282.38 341.95 272.64 C 342 261.63 337.09 249.65 328.95 242.02 C 318.41 232.13 304.8 227.04 290.24 230.04 Z M 96.14 229.63 Q 90.84 230.27 86.03 232.26 Q 79.17 235.12 73.53 239.74 Q 64.22 247.15 60.26 258.59 Q 54.14 275.83 62.16 292.12 Q 66.59 301.13 74.03 306.86 C 79.2 310.85 86.37 313.46 92.63 314.9 Q 99.11 316.4 107.42 315.2 Q 122.46 312.47 132.8 301.21 L 137.99 293.92 Q 140.56 289.68 141.17 287.61 Q 143.99 278.23 143.83 268.53 Q 143.29 262.07 141.56 256.67 C 138.88 248.31 132.31 240.32 125.04 235.91 Q 111.55 227.72 96.14 229.63 Z"
          stroke="currentColor"
          strokeWidth="1.34"
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
