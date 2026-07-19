/**
 * 定义渲染进程允许调用的安全接口。
 */
export interface ElectronApi {
  /** 计算文本的 32 位小写 MD5。 */
  calculateMd5(text: string): Promise<string>
}
