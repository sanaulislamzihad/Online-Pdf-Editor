/**
 * An edit entry exists as soon as a run is selected, so that selecting alone
 * never disturbs the page. Only a real change makes the editor cover the
 * original pixels and makes the exporter touch that line.
 */
export function hasChanges(edit, run) {
  if (!edit || !run) return false
  return (
    !!edit.deleted ||
    (edit.text !== undefined && edit.text !== run.text) ||
    edit.fontSize !== undefined ||
    edit.color !== undefined ||
    edit.bold !== undefined ||
    edit.italic !== undefined ||
    !!edit.dx ||
    !!edit.dy
  )
}

/** Has the text itself been replaced with something we typed? */
export function textRewritten(edit, run) {
  return !!edit && !!run && edit.text !== undefined && edit.text !== run.text
}
