import type { ReactNode } from "react";
import { Info, AlertTriangle, Lightbulb } from "lucide-react";

type Tone = "info" | "warning" | "tip";

interface Props {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}

const TONES: Record<
  Tone,
  { icon: typeof Info; classes: string; iconClasses: string }
> = {
  info: {
    icon: Info,
    classes: "bg-fill-neutral border-l-4 border-purple-700",
    iconClasses: "text-purple-700",
  },
  warning: {
    icon: AlertTriangle,
    classes: "bg-fill-neutral border-l-4 border-warning",
    iconClasses: "text-warning",
  },
  tip: {
    icon: Lightbulb,
    classes: "bg-fill-neutral border-l-4 border-success",
    iconClasses: "text-success",
  },
};

export default function Callout({ tone = "info", title, children }: Props) {
  const { icon: Icon, classes, iconClasses } = TONES[tone];
  return (
    <div className={`${classes} px-4 py-3 mb-4 flex gap-3`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconClasses}`} />
      <div className="text-sm text-fg-contrast leading-6 [&>p:last-child]:mb-0">
        {title && (
          <div className="font-semibold mb-1 text-fg-contrast">{title}</div>
        )}
        {children}
      </div>
    </div>
  );
}
