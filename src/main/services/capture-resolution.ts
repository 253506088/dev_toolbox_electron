import { screen } from 'electron'

/**
 * 以所有显示器中最大的物理分辨率（分辨率 × DPI 缩放系数）作为 desktopCapturer 的抓取尺寸。
 * 固定 1920×1080 会把竖长的微信窗口等比缩小（高度压进 1080），裁剪后只剩三四百像素宽而模糊；
 * 窗口不可能比显示器更大，按显示器物理尺寸申请即可拿到原生分辨率画面。
 */
export function nativeCaptureSize(): { width: number; height: number } {
  let width = 1920
  let height = 1080
  for (const display of screen.getAllDisplays()) {
    width = Math.max(width, Math.ceil(display.size.width * display.scaleFactor))
    height = Math.max(height, Math.ceil(display.size.height * display.scaleFactor))
  }
  return { width, height }
}
