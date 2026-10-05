export function createKoffiBrokerMethods(options?: {
  allowActions?: boolean;
}): { methods: Record<string, (params: unknown, context?: unknown) => Promise<unknown>>; dispose: () => void; allowActions: boolean } | null;
export function loadKoffiBindings(): Record<string, unknown> | null;
export function probePermissionsInProcess(): { accessibility: boolean; screenCapture: boolean; koffiAvailable: boolean };
