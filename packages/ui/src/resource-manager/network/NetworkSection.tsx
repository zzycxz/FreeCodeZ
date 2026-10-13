import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NetworkCaptureSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/index.js";

// U2-6（移植自 ZCode 3.15.1 资源管理器「网络」标签页，上游组件 hXn@≈6456400）：
// 500ms 轮询（无推送）+ 单文本框过滤 + 每页 100 + 时间/进程PID/方法/URL 四列 +
// 「{count} 条 · 已淘汰或丢弃 {dropped} 条」计数行 + 清空（captureId 轮换在 main 侧）。

const NETWORK_PAGE_SIZE = 100;
const NETWORK_POLL_INTERVAL_MS = 500;

export interface NetworkCaptureBridge {
  // 方法简写形态——仓库 TS 6.0.2 对 `name: (): T;` 属性箭头形态有解析怪癖（TS1005）。
  getSnapshot(): Promise<NetworkCaptureSnapshot>;
  clear(): Promise<boolean>;
}

function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

export function NetworkSection({
  network,
}: {
  network: NetworkCaptureBridge | undefined;
}): React.JSX.Element {
  const { intl, locale } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<NetworkCaptureSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [clearing, setClearing] = useState(false);
  const generationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!network) return;
    const generation = generationRef.current;
    try {
      const next = await network.getSnapshot();
      if (generationRef.current !== generation) return;
      setSnapshot(next);
      setFailed(false);
    } catch {
      if (generationRef.current !== generation) return;
      setFailed(true);
    }
  }, [network]);

  useEffect(() => {
    if (!network) return;
    let stopped = false;
    const tick = (): void => {
      if (stopped || clearing) return;
      void refresh().finally(() => {
        if (!stopped) timer = window.setTimeout(tick, NETWORK_POLL_INTERVAL_MS);
      });
    };
    let timer = window.setTimeout(tick, NETWORK_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [network, refresh, clearing]);

  const filteredRecords = useMemo(() => {
    const records = snapshot?.records ?? [];
    const needle = filter.trim().toLowerCase();
    const sorted = [...records].sort((a, b) =>
      b.timestamp !== a.timestamp ? b.timestamp - a.timestamp : b.id - a.id,
    );
    if (!needle) return sorted;
    return sorted.filter((record) =>
      `${record.processType} ${record.pid} ${record.method} ${record.url}`
        .toLowerCase()
        .includes(needle),
    );
  }, [snapshot, filter]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / NETWORK_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRecords = filteredRecords.slice(
    safePage * NETWORK_PAGE_SIZE,
    (safePage + 1) * NETWORK_PAGE_SIZE,
  );

  const handleClear = useCallback(async (): Promise<void> => {
    if (!network || clearing) return;
    setClearing(true);
    try {
      await network.clear();
      setSnapshot(null);
      setPage(0);
      void refresh();
    } finally {
      setClearing(false);
    }
  }, [network, clearing, refresh]);

  if (!network) {
    return (
      <div role="alert" className="p-4 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "resourceManager.network.unavailable" })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "resourceManager.network.description" })}
      </p>
      <div className="flex items-center gap-2">
        <input
          value={filter}
          placeholder={intl.formatMessage({ id: "resourceManager.network.filter" })}
          className="h-7 min-w-0 flex-1 rounded border bg-transparent px-2 text-ui-xs"
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
        />
        <Button size="xs" variant="outline" disabled={clearing} onClick={() => void handleClear()}>
          {intl.formatMessage({ id: "resourceManager.network.clear" })}
        </Button>
      </div>
      <p className="text-ui-xs text-foreground-subtle" data-testid="resource-network-count">
        {intl.formatMessage(
          { id: "resourceManager.network.count" },
          { count: String(filteredRecords.length), dropped: String(snapshot?.dropped ?? 0) },
        )}
      </p>
      {failed ? (
        <div role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "resourceManager.network.unavailable" })}
        </div>
      ) : pageRecords.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui-sm text-foreground-subtle">
          {filter.trim()
            ? intl.formatMessage({ id: "resourceManager.network.noMatches" })
            : intl.formatMessage({ id: "resourceManager.network.empty" })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed" data-testid="resource-network-list">
            <thead>
              <tr className="text-left text-ui-xs text-foreground-subtle">
                <th className="w-24 px-1 py-1 font-normal">
                  {intl.formatMessage({ id: "resourceManager.network.time" })}
                </th>
                <th className="w-28 px-1 py-1 font-normal">
                  {intl.formatMessage({ id: "resourceManager.network.process" })}
                </th>
                <th className="w-20 px-1 py-1 font-normal">
                  {intl.formatMessage({ id: "resourceManager.network.method" })}
                </th>
                <th className="px-1 py-1 font-normal">URL</th>
              </tr>
            </thead>
            <tbody>
              {pageRecords.map((record) => (
                <tr key={record.id} className="border-t text-ui-xs">
                  <td className="px-1 py-1 align-top">{formatTime(record.timestamp, locale)}</td>
                  <td className="px-1 py-1 align-top">
                    <div>{record.processType}</div>
                    <div className="text-foreground-subtle">{record.pid}</div>
                  </td>
                  <td className="px-1 py-1 font-mono align-top">{record.method}</td>
                  <td className="break-all px-1 py-1 align-top select-text" title={record.url}>
                    {record.url}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 text-ui-xs text-foreground-subtle">
        <Button
          size="xs"
          variant="ghost"
          disabled={safePage === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          {intl.formatMessage({ id: "resourceManager.network.previous" })}
        </Button>
        <span>
          {safePage + 1} / {totalPages}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={safePage >= totalPages - 1}
          onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
        >
          {intl.formatMessage({ id: "resourceManager.network.next" })}
        </Button>
      </div>
    </div>
  );
}
