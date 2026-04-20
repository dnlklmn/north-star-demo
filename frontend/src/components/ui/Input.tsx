import { forwardRef } from 'react'
import type { InputHTMLAttributes } from 'react'

type Props = InputHTMLAttributes<HTMLInputElement>

/**
 * Text input matching the North Star Figma spec.
 *
 *   height    56px
 *   padding   16px
 *   bg        gray-50 (#0A0A0A) — sits darker than the page background
 *   border    1px gray-200 (default)
 *              → gray-550 on hover
 *              → purple-700 on focus (with accent caret)
 *   font      Geist (sans) 16px Regular
 *   text      gray-900 when filled, gray-550 when placeholder
 */
const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className = '', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      {...rest}
      className={[
        'h-14 w-full px-4',
        'bg-gray-50 text-base text-gray-900 placeholder:text-gray-550',
        'border border-gray-200 hover:border-gray-550',
        'focus:outline-none focus:border-purple-700 caret-purple-700',
        'transition-colors',
        className,
      ].join(' ')}
    />
  )
})

export default Input
