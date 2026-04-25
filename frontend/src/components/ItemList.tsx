import { useState, useRef, useEffect } from "react";
import Button from "./ui/Button";
import Input from "./ui/Input";
import IconButton from "./ui/IconButton";
import {
  ReturnKeyIcon,
  HelpIcon,
  DragHandleIcon,
  CloseIcon,
  PlusIcon,
} from "./ui/Icons";

/* ── HelpPopover ── */

export function HelpPopover({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative flex items-center" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="w-6 h-6 flex items-center justify-center text-fg-dim hover:text-fg-contrast transition-colors"
        title="Learn more"
      >
        <HelpIcon />
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-20 w-64 p-3 bg-gray-100 border border-border-hint shadow-lg">
          <p className="text-sm font-medium text-fg-contrast mb-1">{title}</p>
          <p className="text-sm text-fg-dim leading-relaxed mb-3">{text}</p>
          <button
            disabled
            className="text-xs font-mono font-semibold text-fg-dim cursor-not-allowed"
          >
            Read docs →
          </button>
        </div>
      )}
    </div>
  );
}

/* ── ItemList ── */

interface ItemListProps {
  /** Section title */
  title: string;
  /** Short description for help popover title */
  helpTitle?: string;
  /** Longer help text */
  helpText?: string;
  /** Items to display */
  items: string[];
  /** Called when a new item is added */
  onAdd?: (value: string) => void;
  /** Called when an item is edited */
  onEdit?: (index: number, value: string) => void;
  /** Called when an item is deleted */
  onDelete?: (index: number) => void;
  /** Called with the full reordered array after drag */
  onReorder?: (items: string[]) => void;
  /** Placeholder for the add input */
  addPlaceholder?: string;
  /** Optional status text shown in header (e.g. "60% ready") */
  statusText?: string;
  /** Color for the status text */
  statusColor?: string;
  /** Called after add/delete/edit for side effects (like regen suggestions) */
  onChanged?: () => void;
  /** Empty state text */
  emptyText?: string;
}

export default function ItemList({
  title,
  helpTitle,
  helpText,
  items,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
  addPlaceholder,
  statusText,
  statusColor,
  onChanged,
  emptyText = "No items yet",
}: ItemListProps) {
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState("");
  const addRowRef = useRef<HTMLDivElement>(null);

  // Click-outside to dismiss add row
  useEffect(() => {
    if (!adding) return;
    const handler = (e: MouseEvent) => {
      if (addRowRef.current && !addRowRef.current.contains(e.target as Node)) {
        setAdding(false);
        setAddValue("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [adding]);

  const handleAddSubmit = () => {
    if (addValue.trim() && onAdd) {
      onAdd(addValue.trim());
      setAddValue("");
      setAdding(false);
      onChanged?.();
    }
  };

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = (index: number) => setDragIndex(index);
  const handleDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIndex(index);
  };
  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const updated = [...items];
    const [moved] = updated.splice(dragIndex, 1);
    updated.splice(index, 0, moved);
    onReorder?.(updated);
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const dragEnabled = !!onReorder && items.length > 1;

  return (
    <div>
      {/* Header row: title + help on the left, status + Add on the right,
          all aligned on a single line so "60% ready" and the Add button sit
          inline with the section title. */}
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-base font-medium text-fg-contrast">{title}</h3>
        {helpTitle && helpText && (
          <HelpPopover title={helpTitle} text={helpText} />
        )}
        <div className="ml-auto flex items-center gap-3">
          {statusText && (
            <span
              className="text-base"
              style={{ color: statusColor }}
            >
              {statusText}
            </span>
          )}
          {onAdd && (
            <Button
              size="small"
              variant="neutral"
              onClick={() => setAdding(true)}
              disabled={adding}
            >
              <PlusIcon />
              Add
            </Button>
          )}
        </div>
      </div>

      {/* Items list */}
      <div className="flex flex-col gap-0.5">
        {adding && (
          <div ref={addRowRef} className="flex items-stretch gap-2.5">
            <Input
              autoFocus
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddSubmit();
                }
                if (e.key === "Escape") {
                  setAddValue("");
                  setAdding(false);
                }
              }}
              placeholder={addPlaceholder ?? `Add ${title.toLowerCase()} item...`}
            />
            <Button
              size="big"
              variant={addValue.trim() ? "primary" : "neutral"}
              onClick={handleAddSubmit}
              disabled={!addValue.trim()}
              shortcut={<ReturnKeyIcon />}
            >
              Submit
            </Button>
          </div>
        )}
        {items.map((item, i) => {
          const showDropIndicator =
            dragIndex !== null && dragOverIndex === i && dragIndex !== i;
          return (
            <div key={i}>
              {showDropIndicator && (
                <div className="h-0.5 -my-px bg-purple-700 relative z-10" />
              )}
              <ItemRow
                text={item}
                onEdit={onEdit ? (v) => onEdit(i, v) : undefined}
                onDelete={
                  onDelete
                    ? () => {
                        onDelete(i);
                        onChanged?.();
                      }
                    : undefined
                }
                draggable={dragEnabled}
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(i, e)}
                onDrop={() => handleDrop(i)}
                onDragEnd={handleDragEnd}
                isDragging={dragIndex === i}
              />
            </div>
          );
        })}
        {items.length === 0 && !adding && (
          <p className="text-sm text-fg-dim italic py-4">{emptyText}</p>
        )}
      </div>
    </div>
  );
}

/* ── ItemRow ── */

function ItemRow({
  text,
  onEdit,
  onDelete,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
}: {
  text: string;
  onEdit?: (value: string) => void;
  onDelete?: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
  isDragging?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  // Click-outside to cancel edit
  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        setEditing(false);
        setValue(text);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing, text]);

  const startEdit = () => {
    if (!onEdit) return;
    setValue(text);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setValue(text);
  };

  const commitEdit = () => {
    if (!value.trim()) return;
    setEditing(false);
    if (value.trim() !== text && onEdit) {
      onEdit(value.trim());
    }
  };

  const changed = value.trim() !== text.trim();

  return (
    <div
      ref={rowRef}
      onClick={!editing ? startEdit : undefined}
      draggable={!editing && draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`group flex items-center justify-between gap-2 py-4 px-4 bg-fill-neutral transition-colors ${
        !editing && onEdit ? "cursor-pointer" : ""
      } ${isDragging ? "opacity-30" : ""}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-base font-medium text-fg-contrast placeholder:text-fg-dim focus:outline-none caret-purple-700"
        />
      ) : (
        <span className="text-base font-medium text-fg-contrast flex-1 min-w-0">
          {text}
        </span>
      )}
      {editing ? (
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button size="small" variant="neutral" onClick={cancelEdit}>
            Cancel
          </Button>
          <Button
            size="small"
            variant={changed && value.trim() ? "primary" : "neutral"}
            shortcut={<ReturnKeyIcon />}
            onClick={commitEdit}
            disabled={!value.trim() || !changed}
          >
            Submit
          </Button>
        </div>
      ) : (
        <>
          {onDelete && (
            <IconButton
              tone="dim"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              title="Remove"
            >
              <CloseIcon />
            </IconButton>
          )}
          <div
            className={`w-10 h-10 flex items-center justify-center flex-shrink-0 transition-colors ${
              draggable
                ? "text-fg-dim hover:text-fg-contrast cursor-grab"
                : "text-fg-dim"
            }`}
          >
            <DragHandleIcon />
          </div>
        </>
      )}
    </div>
  );
}
