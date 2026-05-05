interface BadgeProps {
  text: string
  className: string
}

export default function Badge({ text, className }: BadgeProps) {
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium ${className}`}>
      {text}
    </span>
  )
}
