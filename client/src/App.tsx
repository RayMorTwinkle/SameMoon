import { Routes, Route } from 'react-router-dom';
import { HomePage } from './components/Room/HomePage';
import { RoomPage } from './components/Room/RoomPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/room/:code" element={<RoomPage />} />
    </Routes>
  );
}

export default App;
