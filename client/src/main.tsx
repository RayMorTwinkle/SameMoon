import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
// @ts-expect-error animal-island-ui/style 无类型声明（纯 CSS 副作用导入）
import 'animal-island-ui/style'
import './index.css'
import App from './App.tsx'
import { WebSocketProvider } from './hooks/useWebSocket.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <WebSocketProvider>
        <App />
      </WebSocketProvider>
    </BrowserRouter>
  </StrictMode>,
)
