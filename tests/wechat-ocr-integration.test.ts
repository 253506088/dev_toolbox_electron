import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { WechatOcrController } from '../src/main/services/wechat-ocr-controller'
import { assembleTranscript, buildPageMessages, segmentChatPage } from '../src/shared/wechat-transcript'

/**
 * 端到端集成：合成聊天页 → 版面分割 → Windows 自带 OCR → 文稿组装。
 * 依赖 Windows OCR 中文语言包，仅在 win32 上运行。
 */
describe.skipIf(process.platform !== 'win32')('微信聊天文稿端到端（Windows OCR）', () => {
  it('识别气泡文字并剔除表情包与头像', { timeout: 60_000 }, async () => {
    const pagePath = join(tmpdir(), 'wechat-ocr-e2e.png')
    const svg = `<svg width='400' height='300' xmlns='http://www.w3.org/2000/svg'>
<rect width='400' height='300' fill='#ededed'/>
<rect x='10' y='30' width='40' height='40' fill='#505050'/>
<text x='62' y='24' font-family='Microsoft YaHei' font-size='13' fill='#888888'>张三</text>
<rect x='60' y='30' width='240' height='50' rx='8' fill='#ffffff'/>
<text x='75' y='62' font-family='Microsoft YaHei' font-size='20' fill='#111111'>明天上午十点开会</text>
<rect x='150' y='120' width='230' height='50' rx='8' fill='#95ec69'/>
<text x='165' y='152' font-family='Microsoft YaHei' font-size='20' fill='#111111'>收到准时参加</text>
<rect x='60' y='200' width='120' height='90' fill='#3264c8'/>
<text x='80' y='250' font-family='Microsoft YaHei' font-size='16' fill='#ffffff'>表情包文字</text>
<text x='168' y='190' font-family='Microsoft YaHei' font-size='12' fill='#999999'>10:24</text>
</svg>`
    await sharp(Buffer.from(svg)).png().toFile(pagePath)
    const { data, info } = await sharp(pagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const regions = segmentChatPage(data, info.width, info.height)
    expect(regions.map((region) => region.kind)).toEqual(expect.arrayContaining(['bubble', 'own-bubble', 'media']))

    const controller = WechatOcrController.start()
    try {
      const words = await controller.recognize(pagePath)
      expect(words.length).toBeGreaterThan(4)
      const messages = buildPageMessages(regions, words, info.width)
      const transcript = assembleTranscript([messages], 'e2e')
      expect(transcript).toContain('明天上午十点开会')
      expect(transcript).toContain('收到')
      expect(transcript).toContain('[图片]')
      expect(transcript).not.toContain('表情包文字')
    } finally {
      await controller.stop()
    }
  })
})
