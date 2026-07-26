import { Button, Card, Title } from 'animal-island-ui'

function App() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <Title size="large" color="app-green">
        Same Moon
      </Title>
      <Card color="app-blue" className="mt-6 max-w-md w-full">
        <p className="text-center text-sm opacity-80">
          千里共婵娟 · 异地同步观影
        </p>
        <div className="flex flex-col gap-3 mt-4">
          <Button type="primary" size="large" block>
            创建房间
          </Button>
          <Button type="default" size="large" block>
            加入房间
          </Button>
        </div>
      </Card>
      <p className="mt-6 text-xs opacity-50">
        Phase 1 Step 1 · 项目初始化完成
      </p>
    </div>
  )
}

export default App
