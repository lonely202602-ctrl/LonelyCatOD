/**
 * 后端地址配置。
 * 开发时可以在 apps/web/.env.local 里写 VITE_SERVER_URL=http://192.168.1.10:9090 指向别的机器。
 */
const DEFAULT_SERVER = 'http://localhost:9090';

export const serverUrl: string = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? DEFAULT_SERVER;

/** http(s):// → ws(s):// */
export const wsUrl: string = serverUrl.replace(/^http/, 'ws') + '/ws';

export const apiUrl = (path: string): string => `${serverUrl}/api${path}`;
