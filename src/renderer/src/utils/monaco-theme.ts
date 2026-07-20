import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'

let themesDefined = false

/** 注册与 Neo/Standard、亮色/暗色对应的四套 Monaco 主题。 */
export function ensureMonacoThemes(): void {
  if (themesDefined) return
  themesDefined = true
  monaco.editor.defineTheme('dev-neo-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editorLineNumber.foreground': '#78918E',
      'editorLineNumber.activeForeground': '#0F766E',
      'editor.selectionBackground': '#99F6E455',
      'editorCursor.foreground': '#F97316'
    }
  })
  monaco.editor.defineTheme('dev-standard-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#FFFFFF',
      'editorLineNumber.foreground': '#9CA3AF',
      'editorLineNumber.activeForeground': '#0F766E',
      'editor.selectionBackground': '#BFDBFE88'
    }
  })
  monaco.editor.defineTheme('dev-neo-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#151E1D',
      'editor.foreground': '#E7EFED',
      'editorLineNumber.foreground': '#708A85',
      'editorLineNumber.activeForeground': '#5EEAD4',
      'editor.selectionBackground': '#0F766E88',
      'editor.inactiveSelectionBackground': '#315B5555',
      'editor.lineHighlightBackground': '#22302E',
      'editorCursor.foreground': '#FB923C',
      'diffEditor.insertedTextBackground': '#0F766E55',
      'diffEditor.removedTextBackground': '#B91C1C55',
      'diffEditor.insertedLineBackground': '#134E4A44',
      'diffEditor.removedLineBackground': '#7F1D1D44'
    }
  })
  monaco.editor.defineTheme('dev-standard-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1B1E22',
      'editor.foreground': '#E5E7EB',
      'editorLineNumber.foreground': '#69717C',
      'editorLineNumber.activeForeground': '#5EEAD4',
      'editor.selectionBackground': '#0F766E77',
      'editor.inactiveSelectionBackground': '#33415566',
      'editor.lineHighlightBackground': '#252A30',
      'editorCursor.foreground': '#2DD4BF',
      'diffEditor.insertedTextBackground': '#04785755',
      'diffEditor.removedTextBackground': '#B91C1C55',
      'diffEditor.insertedLineBackground': '#064E3B44',
      'diffEditor.removedLineBackground': '#7F1D1D44'
    }
  })
}
