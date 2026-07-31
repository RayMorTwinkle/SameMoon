import { Routes, Route } from 'react-router-dom';
import { HomePage } from './components/Room/HomePage';
import { RoomPage } from './components/Room/RoomPage';
import { PlayerPage } from './components/Player/PlayerPage';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { DebugPanel } from './components/common/DebugPanel';
import { DebugExport } from './components/common/DebugExport';

function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:code" element={<RoomPage />} />
        <Route path="/room/:code/play" element={<PlayerPage />} />
      </Routes>
      <DebugPanel />
      <DebugExport />
      <div
        style={{ position: 'fixed', left: 6, bottom: 4, fontSize: 10, opacity: 0.35, zIndex: 40, pointerEvents: 'none', color: '#725d42' }}
      >
        v{__APP_VERSION__}
      </div>
    </ErrorBoundary>
  );
}

export default App;
