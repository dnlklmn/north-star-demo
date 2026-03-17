/**
 * Centralized error handling for the application.
 * Provides consistent error logging and user feedback.
 */

type ErrorHandler = (message: string) => void

let errorHandler: ErrorHandler = (message) => {
  // Default: just log to console in development
  if (import.meta.env.DEV) {
    console.error(message)
  }
}

/**
 * Set a custom error handler (e.g., toast notifications)
 */
export function setErrorHandler(handler: ErrorHandler) {
  errorHandler = handler
}

/**
 * Handle an API error with consistent logging and user feedback
 */
export function handleError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : 'Unknown error'

  if (import.meta.env.DEV) {
    console.error(`[${context}]`, error)
  }

  errorHandler(`Failed to ${context}: ${message}`)
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  context: string
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args)
    } catch (error) {
      handleError(error, context)
      throw error
    }
  }) as T
}
