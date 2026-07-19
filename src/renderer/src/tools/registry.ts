import { defineAsyncComponent, type Component } from 'vue'
import type { LucideIcon } from '@lucide/vue'
import {
  Braces,
  CalendarClock,
  CodeXml,
  Columns3,
  Database,
  Diff,
  Fingerprint,
  Link,
  ListFilter,
  TableProperties,
  TextQuote
} from '@lucide/vue'

export interface ToolRegistration {
  id: string
  name: string
  group: string
  icon: LucideIcon
  component: Component
}

/**
 * 第一阶段工具注册表，导航和内容区都只依赖此处。
 */
export const tools: ToolRegistration[] = [
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
