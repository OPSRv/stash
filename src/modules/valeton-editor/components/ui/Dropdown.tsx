import { type ReactNode, useEffect, useRef, useState } from 'react';

interface Props {
  label: ReactNode;
  disabled?: boolean;
  buttonClass?: string;
  dataId?: string;
  title?: string;
  align?: 'left' | 'right';
  children: (close: () => void) => ReactNode;
}

/** Дропдаун на React (замість Bootstrap JS): клік відкриває меню,
   клік поза межами / по пункту — закриває. */
export const Dropdown = ({
  label,
  disabled,
  buttonClass = 'btn btn-soft',
  dataId,
  title,
  align = 'left',
  children,
}: Props) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-id={dataId}
        className={buttonClass}
        disabled={disabled}
        title={title}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <ul
          className={`ve-menu absolute z-40 mt-1 w-max min-w-[13rem] rounded-lg p-1 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </ul>
      )}
    </div>
  );
};

interface ItemProps {
  onClick: () => void;
  dataId?: string;
  children: ReactNode;
}

export const DropdownItem = ({ onClick, dataId, children }: ItemProps) => (
  <li>
    <button
      type="button"
      data-id={dataId}
      className="block w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap text-ve-text hover:bg-white/10 hover:text-white"
      onClick={onClick}
    >
      {children}
    </button>
  </li>
);
