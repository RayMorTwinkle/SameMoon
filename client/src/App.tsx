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
    </ErrorBoundary>
  );
}

export default App;
