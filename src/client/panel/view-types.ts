import type { TFn } from '../i18n'
import type { PanelModel } from '../model'
import type { ClientAction } from '../actions'

/** Shared props for every panel view (pure components). */
export interface ViewProps {
  model: PanelModel
  t: TFn
  onAction: (action: ClientAction) => void
}
