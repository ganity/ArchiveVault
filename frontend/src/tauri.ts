type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

function getInvoke(): Invoke {
  const g: any = (window as any).__TAURI__ ?? {};
  if (g?.core?.invoke) return g.core.invoke;
  if (g?.invoke) return g.invoke;
  if (typeof (window as any).__TAURI_INVOKE__ === "function") return (window as any).__TAURI_INVOKE__;
  if (typeof (window as any).__TAURI_INTERNALS__?.invoke === "function") return (window as any).__TAURI_INTERNALS__.invoke;
  throw new Error("Tauri API 不可用：invoke 缺失");
}

export async function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = getInvoke();
  return await fn(cmd, args);
}

export function listen<T = any>(
  eventName: string,
  handler: (payload: T) => void
): Promise<() => void> {
  const g: any = (window as any).__TAURI__ ?? {};
  const listenFn =
    g?.event?.listen ??
    (window as any).__TAURI_INTERNALS__?.event?.listen ??
    (window as any).__TAURI_INTERNALS__?.listen;
  if (typeof listenFn !== "function") {
    return Promise.reject(new Error("Tauri API 不可用：event.listen 缺失"));
  }
  return listenFn(eventName, (event: any) => handler(event?.payload));
}

export function convertFileSrc(path: string): string {
  const g: any = (window as any).__TAURI__ ?? {};
  const fn = g?.core?.convertFileSrc ?? (window as any).__TAURI_INTERNALS__?.convertFileSrc;
  if (typeof fn === "function") return fn(path);
  return `file://${encodeURI(path)}`;
}
