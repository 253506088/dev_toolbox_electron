import type { CaptureFrameSourceCommand, CaptureFrameSourceResult } from '@shared/capture-frame-source'
import { FrameSource } from './frame-source'

const source = new FrameSource()

window.captureFrameSource.onCommand((command) => {
  void execute(command)
})

async function execute(command: CaptureFrameSourceCommand): Promise<void> {
  let result: CaptureFrameSourceResult
  try {
    switch (command.method) {
      case 'open':
        await source.open(command.payload)
        result = { id: command.id, ok: true }
        break
      case 'fingerprint':
        result = { id: command.id, ok: true, value: source.fingerprint() }
        break
      case 'settle':
        result = {
          id: command.id,
          ok: true,
          value: await source.waitForSettle(command.payload.quietMs, command.payload.maxMs)
        }
        break
      case 'encode':
        result = { id: command.id, ok: true, value: await source.encode(command.payload.frameId) }
        break
      case 'close':
        source.close()
        result = { id: command.id, ok: true }
        break
    }
  } catch (error) {
    result = { id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  window.captureFrameSource.reply(result)
}
