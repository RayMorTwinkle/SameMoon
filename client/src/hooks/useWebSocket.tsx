import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

interface WsContextValue {
  status: WsStatus;
  userId: string | null;
  send: (msg: Record<string, unknown>) => void;
  reconnectCount: number;
  /** 注册消息监听器，返回取消函数 */
  subscribe: (handler: (msg: Record<string, unknown>) => void) => () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [userId, setUserId] = useState<string | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const disposedRef = useRef(false);
  const listenersRef = useRef<Set<(msg: Record<string, unknown>) => void>>(new Set());

  const subscribe = useCallback((handler: (msg: Record<string, unknown>) => void) => {
    listenersRef.current.add(handler);
    return () => { listenersRef.current.delete(handler); };
  }, []);

  const connect = useCallback(() => {
    if (disposedRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    setStatus(retriesRef.current > 0 ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (disposedRef.current) { ws.close(); return; }
      setStatus('connected');
      retriesRef.current = 0;
      setReconnectCount(0);
    };

    ws.onmessage = (event) => {
      if (disposedRef.current) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected' && msg.data?.userId) {
          setUserId(msg.data.userId);
          return;
        }
        for (const handler of listenersRef.current) {
          handler(msg);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (disposedRef.current) return;
      wsRef.current = null;
      setStatus('disconnected');

      if (retriesRef.current < 5) {
        const delay = Math.min(1000 * 2 ** retriesRef.current, 10000);
        retriesRef.current += 1;
        setReconnectCount(retriesRef.current);
        setTimeout(() => {
          if (!disposedRef.current) connect();
        }, delay);
      }
    };

    ws.onerror = () => { ws.close(); };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return (
    <WsContext.Provider value={{ status, userId, send, reconnectCount, subscribe }}>
      {children}
    </WsContext.Provider>
  );
}

export function useWebSocket() {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
  return ctx;
}

/** 订阅消息的便捷 hook */
export function useWsMessage(handler: (msg: Record<string, unknown>) => void) {
  const { subscribe } = useWebSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe((msg) => handlerRef.current(msg));
  }, [subscribe]);
}
