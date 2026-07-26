import { useCallback, useEffect, useRef, useState } from 'react';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

interface UseWebSocketOptions {
  /** 收到消息时的回调 */
  onMessage?: (msg: Record<string, unknown>) => void;
  /** 最大重连次数 */
  maxRetries?: number;
}

interface UseWebSocketReturn {
  status: WsStatus;
  userId: string | null;
  send: (msg: Record<string, unknown>) => void;
  reconnectCount: number;
}

export function useWebSocket(options: UseWebSocketOptions = {}): UseWebSocketReturn {
  const { onMessage, maxRetries = 5 } = options;

  const [status, setStatus] = useState<WsStatus>('connecting');
  const [userId, setUserId] = useState<string | null>(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    setStatus(retriesRef.current > 0 ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      retriesRef.current = 0;
      setReconnectCount(0);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // 首次连接时服务器返回 userId
        if (msg.type === 'connected' && msg.data?.userId) {
          setUserId(msg.data.userId);
          return;
        }

        onMessageRef.current?.(msg);
      } catch {
        // 忽略非 JSON 消息
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
      wsRef.current = null;

      // 自动重连（指数退避）
      if (retriesRef.current < maxRetries) {
        const delay = Math.min(1000 * 2 ** retriesRef.current, 10000);
        retriesRef.current += 1;
        setReconnectCount(retriesRef.current);
        setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [maxRetries]);

  useEffect(() => {
    connect();
    return () => {
      retriesRef.current = maxRetries; // 阻止卸载后重连
      wsRef.current?.close();
    };
  }, [connect, maxRetries]);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { status, userId, send, reconnectCount };
}
