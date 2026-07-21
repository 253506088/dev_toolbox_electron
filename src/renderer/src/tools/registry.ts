import { defineAsyncComponent, type Component } from 'vue'
import type { LucideIcon } from '@lucide/vue'
import {
  Braces,
  Camera,
  CalendarClock,
  CodeXml,
  Columns3,
  Database,
  Diff,
  Fingerprint,
  Film,
  FolderTree,
  Image as ImageIcon,
  Link,
  ListFilter,
  NotebookPen,
  QrCode,
  ScanLine,
  TableProperties,
  TextQuote,
  WandSparkles,
  Video
} from '@lucide/vue'

export interface ToolRegistration {
  id: string
  name: string
  group: string
  icon: LucideIcon
  component: Component
}

/**
 * 工具注册表，导航和内容区都只依赖此处。
 */
export const tools: ToolRegistration[] = [
  {
    id: 'wechat-capture',
    name: '微信长截图',
    group: '日常工具',
    icon: Camera,
    component: defineAsyncComponent(() => import('./WechatCaptureTool.vue'))
  },
  {
    id: 'notes',
    name: '便签与提醒',
    group: '日常工具',
    icon: NotebookPen,
    component: defineAsyncComponent(() => import('./NotesTool.vue'))
  },
  {
    id: 'file-manager',
    name: '文件管理器',
    group: '日常工具',
    icon: FolderTree,
    component: defineAsyncComponent(() => import('./FileManagerTool.vue'))
  },
  {
    id: 'qr-code',
    name: '二维码',
    group: '日常工具',
    icon: QrCode,
    component: defineAsyncComponent(() => import('./QrTool.vue'))
  },
  {
    id: 'sd-prompt',
    name: 'SD 提示词',
    group: '日常工具',
    icon: WandSparkles,
    component: defineAsyncComponent(() => import('./SdPromptTool.vue'))
  },
  {
    id: 'image-resize',
    name: '图片缩放裁剪',
    group: '图片与视频',
    icon: ImageIcon,
    component: defineAsyncComponent(() => import('./ImageResizeTool.vue'))
  },
  {
    id: 'image-matting',
    name: '批量抠图',
    group: '图片与视频',
    icon: ScanLine,
    component: defineAsyncComponent(() => import('./ImageMattingTool.vue'))
  },
  {
    id: 'video-frame',
    name: '视频转序列帧',
    group: '图片与视频',
    icon: Film,
    component: defineAsyncComponent(() => import('./VideoFrameTool.vue'))
  },
  {
    id: 'video-matting',
    name: '视频抠图',
    group: '图片与视频',
    icon: Video,
    component: defineAsyncComponent(() => import('./VideoMattingTool.vue'))
  },
  {
    id: 'diff',
    name: '文本对比',
    group: '文本处理',
    icon: Diff,
    component: defineAsyncComponent(() => import('./DiffTool.vue'))
  },
  {
    id: 'sql-in',
    name: 'SQL IN',
    group: '文本处理',
    icon: ListFilter,
    component: defineAsyncComponent(() => import('./SqlInTool.vue'))
  },
  {
    id: 'sql-format',
    name: 'SQL 格式化',
    group: '文本处理',
    icon: Database,
    component: defineAsyncComponent(() => import('./SqlFormatterTool.vue'))
  },
  {
    id: 'json',
    name: 'JSON',
    group: '文本处理',
    icon: Braces,
    component: defineAsyncComponent(() => import('./JsonTool.vue'))
  },
  {
    id: 'excel',
    name: 'Excel 表格',
    group: '文本处理',
    icon: TableProperties,
    component: defineAsyncComponent(() => import('./ExcelTool.vue'))
  },
  {
    id: 'time',
    name: '时间转换',
    group: '转换与编码',
    icon: CalendarClock,
    component: defineAsyncComponent(() => import('./TimeTool.vue'))
  },
  {
    id: 'base64',
    name: 'Base64',
    group: '转换与编码',
    icon: TextQuote,
    component: defineAsyncComponent(() => import('./Base64Tool.vue'))
  },
  {
    id: 'md5',
    name: 'MD5',
    group: '转换与编码',
    icon: Fingerprint,
    component: defineAsyncComponent(() => import('./Md5Tool.vue'))
  },
  {
    id: 'url',
    name: 'URL 编解码',
    group: '转换与编码',
    icon: Link,
    component: defineAsyncComponent(() => import('./UrlTool.vue'))
  },
  {
    id: 'cron',
    name: 'Cron 表达式',
    group: '转换与编码',
    icon: Columns3,
    component: defineAsyncComponent(() => import('./CronTool.vue'))
  },
  {
    id: 'xml-json',
    name: 'XML / JSON',
    group: '转换与编码',
    icon: CodeXml,
    component: defineAsyncComponent(() => import('./XmlJsonTool.vue'))
  }
]

/**
 * 按注册顺序生成导航分组。
 */
export function groupTools(): Array<{ name: string; items: ToolRegistration[] }> {
  const groups = new Map<string, ToolRegistration[]>()
  for (const tool of tools) {
    const items = groups.get(tool.group) ?? []
    items.push(tool)
    groups.set(tool.group, items)
  }
  return [...groups].map(([name, items]) => ({ name, items }))
}
