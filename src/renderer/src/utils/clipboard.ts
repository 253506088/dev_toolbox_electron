/**
 * 把文本写入系统剪贴板。
 */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}
