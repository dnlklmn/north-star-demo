interface BadgeProps {
  text: string
  className: string
}

export default function Badge({ text, className }: BadgeProps) {
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${className}`}>
      {text}
    </span>
  )
}

export const SOURCE_COLORS: Record<string, string> = {
  imported: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  synthetic: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  manual: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300',
}

export const LABEL_COLORS: Record<string, string> = {
  good: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  bad: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  unlabeled: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
}

export const REVIEW_COLORS: Record<string, string> = {
  pending: 'border-l-yellow-400',
  approved: 'border-l-green-400',
  rejected: 'border-l-red-400',
  needs_edit: 'border-l-orange-400',
}
