/**
 * Note an out-of-chat activity (button click, tab switch, navigation, etc.)
 * so it shows up as an inline marker in the Polaris transcript.
 *
 * The transcript is the user's running mental model of "what just happened
 * in this project." Without these hints, manual UI actions are invisible to
 * Polaris's conversation surface — making it confusing to follow when the
 * user mixes button clicks and chat.
 *
 * Fire-and-forget. Uses a window CustomEvent so any component can emit
 * without importing the provider.
 */
export function notePolarisActivity(activity: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('polaris:activity', { detail: { activity } }),
  )
}
