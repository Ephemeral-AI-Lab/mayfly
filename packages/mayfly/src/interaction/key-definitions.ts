/** Shared key declarations without native command or settings ownership. @module */
import type { MayflyKeyAction } from '../core/types.ts'
import {
  ACTION_BACKSPACE, ACTION_CANCEL, ACTION_CLEAR_SEARCH, ACTION_CLOSE_AGENT_VIEW, ACTION_COPY, ACTION_CYCLE_MODE, ACTION_CYCLE_MODEL,
  ACTION_DELETE, ACTION_END, ACTION_EXPAND, ACTION_EXTERNAL_EDITOR, ACTION_FILTER, ACTION_FOCUS_NEXT, ACTION_FOCUS_PREV, ACTION_FOLLOW_TAIL, ACTION_HOME,
  ACTION_INTERRUPT, ACTION_MOVE_DOWN, ACTION_MOVE_UP, ACTION_NEWLINE, ACTION_NEXT_CONTROL, ACTION_NEXT_TAB, ACTION_PAGE_DOWN,
  ACTION_PAGE_UP, ACTION_PREV_TAB, ACTION_REFRESH, ACTION_RESET_FIELD, ACTION_SAVE, ACTION_SEARCH, ACTION_SEGMENT_LEFT,
  ACTION_SEGMENT_RIGHT, ACTION_SHIFT_TAB, ACTION_STEER, ACTION_SUBMIT, ACTION_TOGGLE, ACTION_TOGGLE_AGENT_VIEW,
} from '../core/key-actions.ts'

/**
 * The full interaction key batch, registered as one unit: the kit's `ui.*` navigation and common-meaning actions, then
 * the product actions. Each carries the scope its binding is live in (roadmap D6), so `Ctrl+Enter` can steer in the editor and `Ctrl+S`
 * can save in a surface, and `Shift+Tab` can toggle plan mode in the editor and move back a group in a surface.
 */
export const INTERACTION_KEY_ACTIONS: readonly MayflyKeyAction[] = [
  { id: ACTION_SUBMIT, keys: 'enter', scope: 'surface', description: 'Submit input / confirm selection' },
  { id: ACTION_CANCEL, keys: 'escape', scope: 'global', description: 'Cancel or dismiss the active surface' },
  { id: ACTION_MOVE_UP, keys: 'up', scope: 'global', description: 'Move the list cursor up' },
  { id: ACTION_MOVE_DOWN, keys: 'down', scope: 'global', description: 'Move the list cursor down' },
  { id: ACTION_SEGMENT_LEFT, keys: 'left', scope: 'surface', description: 'Move left: step a value, a segment, or a tab, or close a branch' },
  { id: ACTION_SEGMENT_RIGHT, keys: 'right', scope: 'surface', description: 'Move right: step a value, a segment, or a tab, or open a branch' },
  { id: ACTION_TOGGLE, keys: 'space', scope: 'surface', description: 'Toggle the focused choice in a multi-select' },
  { id: ACTION_NEXT_CONTROL, keys: 'tab', scope: 'surface', description: 'Move to the next control' },
  { id: ACTION_SHIFT_TAB, keys: 'shift+tab', scope: 'surface', description: 'Move to the previous control' },
  { id: ACTION_PAGE_UP, keys: 'pageUp', scope: 'global', description: 'Move one page up' },
  { id: ACTION_PAGE_DOWN, keys: 'pageDown', scope: 'global', description: 'Move one page down' },
  { id: ACTION_HOME, keys: 'home', scope: 'surface', description: 'Move to the first item' },
  { id: ACTION_END, keys: 'end', scope: 'global', description: 'Move to the last item' },
  { id: ACTION_RESET_FIELD, keys: 'delete', scope: 'surface', description: 'Return the focused form field to its inherited or default value' },
  { id: ACTION_FILTER, keys: '/', scope: 'surface', description: 'Start filtering a list' },
  { id: ACTION_CLEAR_SEARCH, keys: 'ctrl+u', scope: 'surface', description: 'Clear the active search query' },
  { id: ACTION_EXPAND, keys: 'ctrl+e', scope: 'surface', description: 'Expand the focused content to a full-screen view' },
  { id: ACTION_NEWLINE, keys: ['alt+enter', 'ctrl+j'], scope: 'surface', description: 'Insert a newline in a multiline field' },
  { id: ACTION_PREV_TAB, keys: ['alt+left', 'f2'], scope: 'surface', description: 'Switch to the previous tab' },
  { id: ACTION_NEXT_TAB, keys: ['alt+right', 'f3'], scope: 'surface', description: 'Switch to the next tab' },
  { id: ACTION_FOCUS_PREV, keys: ['alt+up', 'f4'], scope: 'surface', description: 'Move focus to the previous control' },
  { id: ACTION_FOCUS_NEXT, keys: ['alt+down', 'f5'], scope: 'surface', description: 'Move focus to the next control' },
  { id: ACTION_SAVE, keys: 'ctrl+s', scope: 'surface', description: 'Save the form' },
  { id: ACTION_COPY, keys: 'c', scope: 'surface', description: 'Copy the focused row or content' },
  { id: ACTION_DELETE, keys: 'x', scope: 'surface', description: 'Delete, remove, or stop the focused row, asking first' },
  { id: ACTION_REFRESH, keys: 'r', scope: 'surface', description: 'Refresh or retry' },
  { id: ACTION_EXTERNAL_EDITOR, keys: 'ctrl+g', scope: 'global', description: 'Edit the draft in your external editor ($VISUAL/$EDITOR)' },
  { id: ACTION_SEARCH, keys: 'ctrl+f', scope: 'surface', description: 'Search the whole conversation or list' },
  { id: ACTION_INTERRUPT, keys: 'ctrl+c', scope: 'global', description: 'Clear input / interrupt with an empty buffer / press twice to exit' },
  { id: ACTION_STEER, keys: 'ctrl+enter', scope: 'editor', description: 'Send the draft as a steer: the running turn takes it at its next step' },
  { id: ACTION_BACKSPACE, keys: 'backspace', scope: 'editor', description: 'Delete backward / exit bash mode on an empty prompt' },
  { id: ACTION_CYCLE_MODE, keys: 'shift+tab', scope: 'editor', description: 'Toggle plan mode' },
  { id: ACTION_CYCLE_MODEL, keys: 'alt+m', scope: 'editor', description: 'Cycle the session model within the current provider (contextual)' },
  { id: ACTION_TOGGLE_AGENT_VIEW, keys: 'f7', scope: 'global', description: 'Return to the previous conversation' },
  { id: ACTION_CLOSE_AGENT_VIEW, keys: 'f8', scope: 'global', description: 'Close the displayed side conversation' },
  { id: ACTION_FOLLOW_TAIL, keys: 'ctrl+down', scope: 'global', description: 'Jump to the new-messages marker, then to the newest conversation content and follow it' },
]

