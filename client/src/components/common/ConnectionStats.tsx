import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, Activity } from 'lucide-react';
import { debugStore } from '../../services/debugStore';
import type { PCStatsSnapshot, SelectedPair } from '../../services/webrtc/types';

/**
 * 实时连接状态条：连接路线（直连/STUN/TURN + IPv4/IPv6）、真实收发码率、RTT
 * 数据来源：PCStatsCollector 每 2s 写入 debugStore.rtcStats
 */

function routeLabel(pair: SelectedPair | null): string {
  if (!pair) return '协商中…';
  const types = [pair.local.type, pair.remote.type];
  const isV6 = pair.local.address.includes(':') || pair.remote.address.includes(':');
  if (types.includes('relay')) return 'TURN 中继';
  if (types.includes('srflx') || types.includes('prflx')) {
    return isV6 ? 'P2P 直连 · IPv6' : 'P2P 直连 · STUN';
  }
  return isV6 ? 'IPv6 直连' : '局域网直连';
}

function fmtKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} Kbps`;
}

export function ConnectionStats() {
  const [stats, setStats] = useState<PCStatsSnapshot | null>(debugStore.getState().rtcStats);

  useEffect(() => debugStore.subscribe(s => setStats(s.rtcStats)), []);

  if (!stats) return null;

  return (
    <div className="flex items-center justify-center gap-3 text-[11px] text-gray-500 flex-wrap">
      <span className="flex items-center gap-1">
        <Activity size={11} className="text-[#19c8b9]" />
        {routeLabel(stats.selectedPair)}
      </span>
      <span className="flex items-center gap-0.5">
        <ArrowUp size={11} />
        {fmtKbps(stats.sendBitrateKbps)}
      </span>
      <span className="flex items-center gap-0.5">
        <ArrowDown size={11} />
        {fmtKbps(stats.recvBitrateKbps)}
      </span>
      {stats.currentRoundTripTime > 0 && <span>RTT {stats.currentRoundTripTime}ms</span>}
    </div>
  );
}
