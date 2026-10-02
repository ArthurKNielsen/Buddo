import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, icon, children, footer, width = 640, className = '', closable = true }) {
  useEffect(() => {
    if (!open || !closable) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closable, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} onMouseDown={(e) => closable && e.target === e.currentTarget && onClose?.()}>
          <motion.div
            className={'modal ' + className}
            style={{ width: `min(${width}px, 100%)` }}
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            {title && (
              <div className="modal-head">
                {icon}
                <h2>{title}</h2>
                <span className="spacer" />
                {closable && (
                  <button className="icon-btn sm" onClick={onClose}>
                    <X size={16} />
                  </button>
                )}
              </div>
            )}
            {children}
            {footer && <div className="modal-foot">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
