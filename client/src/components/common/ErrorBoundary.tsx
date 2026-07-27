import { Component, type ReactNode } from 'react';
import { Button, Card, Title } from 'animal-island-ui';
import { Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-6">
          <Title size="large" color="app-red">
            出错了
          </Title>
          <Card color="app-yellow" className="mt-6 max-w-sm w-full">
            <div className="text-center py-4">
              <p className="text-sm text-[#725d42] mb-2">
                页面遇到了意外错误
              </p>
              <p className="text-xs opacity-50 mb-2 font-mono break-all">
                {this.state.error?.message ?? '未知错误'}
              </p>
              <p className="text-xs opacity-40 mb-4">
                刷新页面通常可以解决，所有数据均已保存
              </p>
              <div className="flex flex-col gap-2">
                <Button type="primary" size="large" block onClick={this.handleReset}>
                  重试
                </Button>
                <Button type="default" size="large" block onClick={() => window.location.href = '/'}>
                  <Home size={18} className="mr-1 inline" />
                  返回首页
                </Button>
              </div>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
