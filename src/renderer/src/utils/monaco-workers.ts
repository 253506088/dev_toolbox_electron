import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'

/**
 * 为 Monaco 分配独立语言线程，避免编辑大文本时占用界面线程。
 */
const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment: {
    getWorker(moduleId: string, label: string): Worker
  }
}

monacoGlobal.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    if (label === 'json') return new JsonWorker()
    return new EditorWorker()
  }
}
